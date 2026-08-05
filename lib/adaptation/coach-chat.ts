/**
 * The coach conversation: an athlete's message becomes an adapted plan.
 *
 * Flow, and the boundary at each step:
 *
 *   text ──(LLM: parse only)──► facts ──(deterministic)──► constraints
 *        ──(solver)──► plan ──(LLM: phrase only)──► reply
 *
 * The LLM appears twice and decides nothing either time. Everything between is
 * reproducible from the stored `parsed` structure, which is why any change can
 * be explained months later.
 */
import { prisma } from "../prisma";
import OpenAI from "openai";
import { parseAthleteMessage, ParsedReport } from "./intent-parser";
import { assessRisk, RiskAssessment } from "./risk";
import { planOpportunity, OpportunityPlan } from "./opportunity";
import { adaptPlanForUser, AdaptationOutcome } from "./engine";
import { localISO } from "./load-vector";

export interface CoachReply {
  understood: boolean;
  reply: string;
  parsed: ParsedReport;
  risk: RiskAssessment | null;
  opportunity: OpportunityPlan | null;
  outcome: AdaptationOutcome | null;
  reportId: string | null;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** A compact snapshot of the coming week, so the coach answers from the real plan. */
async function upcomingPlan(userId: string, now: Date): Promise<{
  hasPlan: boolean;
  raceDate: string | null;
  daysToRace: number | null;
  sessions: Array<{
    date: string;
    day: string;
    discipline: string;
    type: string;
    duration: string;
    tss: number;
    isAnchor: boolean;
    status: string;
  }>;
}> {
  const [plan, profile] = await Promise.all([
    prisma.trainingPlan.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: { id: true, targetRaceDate: true },
    }),
    prisma.athleteProfile.findUnique({
      where: { userId },
      select: { raceDate: true },
    }),
  ]);

  const raceDate = plan?.targetRaceDate ?? profile?.raceDate ?? null;
  const daysToRace = raceDate
    ? Math.round(
        (startOfDay(raceDate).getTime() - startOfDay(now).getTime()) / 86400000
      )
    : null;

  if (!plan)
    return {
      hasPlan: false,
      raceDate: raceDate ? localISO(raceDate) : null,
      daysToRace,
      sessions: [],
    };

  const rows = await prisma.plannedSession.findMany({
    where: {
      planId: plan.id,
      scheduledDate: { gte: startOfDay(now), lte: addDays(startOfDay(now), 6) },
      status: { in: ["planned", "adapted"] },
    },
    orderBy: { scheduledDate: "asc" },
    select: {
      scheduledDate: true,
      discipline: true,
      type: true,
      duration: true,
      tss: true,
      isAnchor: true,
      status: true,
    },
  });

  return {
    hasPlan: true,
    raceDate: raceDate ? localISO(raceDate) : null,
    daysToRace,
    sessions: rows.map((r) => ({
      date: localISO(r.scheduledDate!),
      day: WEEKDAYS[r.scheduledDate!.getDay()],
      discipline: r.discipline,
      type: r.type,
      duration: r.duration,
      tss: r.tss,
      isAnchor: r.isAnchor,
      status: r.status,
    })),
  };
}

/**
 * Handles one message from the athlete.
 *
 * @param dryRun parse and decide without writing, for testing and previews.
 */
export async function handleAthleteMessage(
  userId: string,
  text: string,
  opts: { now?: Date; dryRun?: boolean } = {}
): Promise<CoachReply> {
  const now = opts.now ?? new Date();
  const today = localISO(startOfDay(now));

  // The coach needs the real plan to hand even a plain question ("should I do
  // a brick tomorrow?"), so it is gathered before we know whether the message
  // is a report or a question.
  const plan = await upcomingPlan(userId, now);

  const parsed = await parseAthleteMessage(text, today);

  // ---- A question, or anything with nothing actionable -------------------
  // The engine decides plan changes; a question changes nothing. But the reply
  // must still read like a coach answering a coach — not a validation error.
  if (parsed.empty) {
    const fallback =
      "I could not find anything in that I can act on. " +
      "Tell me how you are feeling, or what you will not have access to and " +
      "for how long — for example \u201cno bike until Thursday\u201d or " +
      "\u201cslept badly, left calf is sore\u201d.";
    const reply = await composeCoachReply({
      text,
      today,
      understood: false,
      parsed,
      risk: null,
      opportunity: null,
      outcome: null,
      plan,
      fallback,
    });

    let reportId: string | null = null;
    if (!opts.dryRun) {
      const row = await prisma.athleteReport.create({
        data: {
          userId,
          rawText: text,
          parsed: JSON.parse(JSON.stringify(parsed)),
          fromDate: new Date(today + "T00:00:00"),
          toDate: new Date(today + "T00:00:00"),
          reply,
        },
      });
      reportId = row.id;
    }

    return {
      understood: false,
      reply,
      parsed,
      risk: null,
      opportunity: null,
      outcome: null,
      reportId,
    };
  }

  const daysToRace = plan.daysToRace;

  // Load already planned inside the constrained window, per discipline.
  const plannedByDiscipline: Record<string, number> = {};
  let mechanicalHeadroom: number | null = null;

  {
    const planRow = await prisma.trainingPlan.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (planRow) {
      const windowSessions = await prisma.plannedSession.findMany({
        where: {
          planId: planRow.id,
          scheduledDate: {
            gte: new Date(parsed.fromDate + "T00:00:00"),
            lte: new Date(parsed.toDate + "T23:59:59"),
          },
          status: { in: ["planned", "adapted"] },
        },
        select: { discipline: true, tss: true },
      });
      for (const s of windowSessions) {
        const key = s.discipline.toLowerCase();
        const d = key.includes("swim")
          ? "swim"
          : key.includes("bike") || key.includes("ride")
            ? "bike"
            : key.includes("run")
              ? "run"
              : "strength";
        plannedByDiscipline[d] = (plannedByDiscipline[d] ?? 0) + s.tss;
      }
    }
  }

  // ---- Function A: risk -------------------------------------------------
  const { acwr, glycogen, mechanicalRoom } = await currentPhysiology(userId, now);
  mechanicalHeadroom = mechanicalRoom;

  const risk = assessRisk({ report: parsed, acwr, glycogen, daysToRace }, today);

  // ---- Function B: opportunity ------------------------------------------
  const limiterPriority = await limiterPriorityFor(userId);
  const opportunity = planOpportunity({
    report: parsed,
    plannedByDiscipline,
    limiterPriority,
    mechanicalHeadroom,
  });

  // ---- Store the report before acting on it -----------------------------
  let reportId: string | null = null;
  if (!opts.dryRun) {
    const row = await prisma.athleteReport.create({
      data: {
        userId,
        rawText: text,
        parsed: JSON.parse(JSON.stringify(parsed)),
        fromDate: new Date(parsed.fromDate + "T00:00:00"),
        toDate: new Date(parsed.toDate + "T00:00:00"),
      },
    });
    reportId = row.id;
  }

  // ---- Re-plan -----------------------------------------------------------
  // reportOnly: answer the message, not the whole week's load balance.
  const outcome = plan.hasPlan
    ? await adaptPlanForUser(userId, {
        now,
        trigger: "athlete_report",
        dryRun: opts.dryRun,
        reportOnly: true,
        extraConstraints: [...risk.constraints, ...opportunity.constraints],
        extraPreferences: opportunity.preferences,
      })
    : null;

  // ---- Reply -------------------------------------------------------------
  const reply = await composeCoachReply({
    text,
    today,
    understood: true,
    parsed,
    risk,
    opportunity,
    outcome,
    plan,
    fallback: deterministicReply({ risk, opportunity, outcome }),
  });

  if (reportId && !opts.dryRun) {
    await prisma.athleteReport.update({
      where: { id: reportId },
      data: { reply, adaptationId: outcome?.adaptationId ?? null },
    });
  }

  return {
    understood: true,
    reply,
    parsed,
    risk,
    opportunity,
    outcome,
    reportId,
  };
}

/** Current physiological context, for the risk calculation. */
async function currentPhysiology(userId: string, now: Date) {
  const { loadVectorFor, dailySeries, ewma, acwr: acwrOf, totalLoad } = await import(
    "./load-vector"
  );
  const { metabolicState } = await import("./physiology");

  const since = new Date(now.getTime() - 60 * 86400000);
  const activities = await prisma.stravaActivity.findMany({
    where: { userId, startDate: { gte: since } },
    select: {
      startDate: true, discipline: true, name: true, estimatedTss: true,
      distance: true, elevationGain: true,
    },
  });

  const loads = activities.map((a) => ({
    date: localISO(a.startDate),
    load: loadVectorFor({
      discipline: a.discipline, tss: a.estimatedTss, type: a.name,
      distanceKm: a.distance ? a.distance / 1000 : null,
      elevationGainM: a.elevationGain,
    }),
  }));

  const today = localISO(startOfDay(now));
  const chronic = ewma(dailySeries(loads, localISO(since), today), 42);
  const acute = ewma(
    dailySeries(loads, localISO(new Date(now.getTime() - 7 * 86400000)), today),
    7
  );
  const ratios = acwrOf(acute, chronic);
  const worst = Math.max(ratios.metabolic, ratios.mechanical, ratios.neuromuscular);

  const metabolic = metabolicState(loads, now);

  // Mechanical headroom for the coming week, at the +5% impact ramp cap.
  const lastWeek = loads
    .filter((l) => l.date >= localISO(new Date(now.getTime() - 7 * 86400000)))
    .reduce((n, l) => n + l.load.mechanical, 0);
  const mechanicalRoom = lastWeek > 0 ? lastWeek * 0.05 : null;

  return {
    acwr: totalLoad(chronic) > 0 ? worst : null,
    glycogen: metabolic.glycogen,
    mechanicalRoom,
  };
}

/** Race-course ROI, so a focus block targets what actually wins time. */
async function limiterPriorityFor(userId: string): Promise<Record<string, number>> {
  try {
    const { analyseLimiters } = await import("./limiter");
    const { normaliseDiscipline } = await import("./load-vector");
    const [profile, race, rides] = await Promise.all([
      prisma.athleteProfile.findUnique({
        where: { userId },
        select: { swimCssSecPer100: true, runThresholdPaceSec: true, raceType: true },
      }),
      prisma.raceProfile.findUnique({ where: { userId } }),
      prisma.stravaActivity.findMany({
        where: { userId, avgSpeed: { not: null } },
        orderBy: { startDate: "desc" },
        take: 40,
        select: { avgSpeed: true, discipline: true },
      }),
    ]);
    const speeds = rides
      .filter((r) => normaliseDiscipline(r.discipline) === "bike")
      .map((r) => r.avgSpeed!)
      .sort((a, b) => a - b);
    const analysis = analyseLimiters(
      {
        swimCssSecPer100: profile?.swimCssSecPer100 ?? null,
        runThresholdPaceSec: profile?.runThresholdPaceSec ?? null,
        bikeSpeedMs: speeds.length ? speeds[Math.floor(speeds.length / 2)] : null,
      },
      {
        raceType: race?.distanceType ?? profile?.raceType ?? null,
        swimEnvironment: race?.swimEnvironment ?? null,
        wetsuitLikely: race?.wetsuitLikely ?? null,
        bikeElevationGainM: race?.bikeElevationGainM ?? null,
        runElevationGainM: race?.runElevationGainM ?? null,
        runSurface: race?.runSurface ?? null,
      }
    );
    return analysis.priority;
  } catch {
    return {};
  }
}

/** What the engine decided, in plain deterministic language (the fallback). */
function deterministicReply(args: {
  risk: RiskAssessment | null;
  opportunity: OpportunityPlan | null;
  outcome: AdaptationOutcome | null;
}): string {
  const { risk, opportunity, outcome } = args;

  const deterministic: string[] = [];
  if (risk?.decision === "rest") {
    deterministic.push("Today becomes a rest day.");
  } else if (risk?.decision === "easy_only") {
    deterministic.push("Intensity is capped until this settles — easy only.");
  } else if (risk?.decision === "downgrade") {
    deterministic.push("Sessions are eased back.");
  }
  deterministic.push(...(opportunity?.rationale ?? []));
  if (outcome?.changes?.length) {
    deterministic.push(
      `${outcome.changes.length} session${outcome.changes.length === 1 ? "" : "s"} moved or reshaped.`
    );
  }
  if (deterministic.length === 0) {
    deterministic.push(
      "Noted. Nothing needed to change — your plan already fits around it."
    );
  }

  // A plan the solver could not repair must say so. Replying "no changes were
  // needed" when it was actually blocked is the reassuring dishonesty this
  // project keeps having to root out.
  if (outcome?.outcome === "blocked_frozen") {
    deterministic.push(
      "I could not fit a safe version of this week around what is already " +
        "locked in. " +
        (outcome.reason ? `The sticking point: ${outcome.reason}.` : "")
    );
  } else if (outcome?.outcome === "rejected_hysteresis") {
    deterministic.push(
      "A change was possible but too small to be worth disrupting your week."
    );
  }

  return deterministic.join(" ");
}

const COACH_SYSTEM_PROMPT = [
  "You are a triathlon coach inside TriApp, talking to an age-group triathlete.",
  "Answer naturally and conversationally, the way a good coach answers in a chat.",
  "",
  "Rules:",
  "- Ground every claim in the facts given below. NEVER invent sessions, dates,",
  "  numbers, paces, or training history.",
  "- If the athlete asked a question, answer it directly, using the plan shown.",
  "- If the plan was changed, explain plainly what changed and why, based only on",
  "  the listed changes and the reasons given.",
  "- If nothing was changed, say so naturally and, where useful, what the athlete",
  "  can do instead.",
  "- 2-5 sentences. Plain and direct. No cheerleading, no bullet points, no",
  "  markdown, no emojis.",
].join("\n");

/**
 * Composes the reply conversationally. The plan changes were decided by the
 * deterministic engine; this LLM only phrases the answer and can handle plain
 * questions ("should I do a brick tomorrow?") that the engine never sees.
 */
async function composeCoachReply(args: {
  text: string;
  today: string;
  understood: boolean;
  parsed: ParsedReport;
  risk: RiskAssessment | null;
  opportunity: OpportunityPlan | null;
  outcome: AdaptationOutcome | null;
  plan: Awaited<ReturnType<typeof upcomingPlan>>;
  fallback: string;
}): Promise<string> {
  const { text, today, parsed, risk, opportunity, outcome, plan, fallback } = args;
  if (!process.env.OPENAI_API_KEY) return fallback;

  const changes = outcome?.changes ?? [];
  const reasoned = deterministicReply({ risk, opportunity, outcome });

  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.3,
      max_tokens: 300,
      messages: [
        { role: "system", content: COACH_SYSTEM_PROMPT },
        {
          role: "user",
          content: JSON.stringify(
            {
              today,
              daysToRace: plan.daysToRace,
              raceDate: plan.raceDate,
              athleteSaid: text,
              whatWeUnderstood: {
                fatigue: parsed.fatigue,
                sleepQuality: parsed.sleepQuality,
                alcoholUnits: parsed.alcoholUnits,
                stress: parsed.stress,
                illness: parsed.illness,
                niggles: parsed.niggles,
                unavailableDisciplines: parsed.unavailableDisciplines,
                availableDisciplines: parsed.availableDisciplines,
                missingEquipment: parsed.missingEquipment,
                window: [parsed.fromDate, parsed.toDate],
              },
              riskAssessment: risk
                ? {
                    decision: risk.decision,
                    reasons: risk.reasons,
                  }
                : null,
              logistics: opportunity
                ? {
                    blocked: opportunity.blocked,
                    focus: opportunity.focus,
                    rationale: opportunity.rationale,
                  }
                : null,
              planChanges:
                changes.length > 0
                  ? changes.map((c) => ({
                      discipline: c.discipline,
                      change: c.change,
                      fromDate: c.fromDate,
                      toDate: c.toDate ?? undefined,
                      fromTss: c.fromTss ?? undefined,
                      toTss: c.toTss ?? undefined,
                    }))
                  : "none",
              blockedOrUnrepairable:
                outcome?.outcome === "blocked_frozen"
                  ? outcome.reason
                  : outcome?.outcome === "rejected_hysteresis"
                    ? "A change was possible but too small to be worth disrupting the week."
                    : null,
              thePlan: plan.hasPlan
                ? plan.sessions.map(
                    (s) =>
                      `${s.day} ${s.date}: ${s.discipline} ${s.type} ` +
                      `(${s.duration}, ${s.tss} TSS)${s.isAnchor ? " [key]" : ""}`
                  )
                : "no plan",
              whatTheEngineReasoned: reasoned,
            },
            null,
            2
          ),
        },
      ],
    });

    const reply = response.choices[0]?.message?.content?.trim();
    return reply && reply.length > 0 ? reply : fallback;
  } catch (e) {
    console.error("[coach-chat] reply failed, using deterministic text:", e);
    return fallback;
  }
}

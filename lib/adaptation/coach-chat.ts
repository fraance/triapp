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
import { parseAthleteMessage, ParsedReport } from "./intent-parser";
import { assessRisk, RiskAssessment } from "./risk";
import { planOpportunity, OpportunityPlan } from "./opportunity";
import { adaptPlanForUser, AdaptationOutcome } from "./engine";
import { localISO } from "./load-vector";
import { narrate } from "./narrator";

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

  const parsed = await parseAthleteMessage(text, today);

  if (parsed.empty) {
    return {
      understood: false,
      reply:
        "I could not find anything in that I can act on. Tell me how you are " +
        "feeling, or what you will not have access to and for how long — " +
        "for example \u201cno bike until Thursday\u201d or \u201cslept badly, " +
        "left calf is sore\u201d.",
      parsed,
      risk: null,
      opportunity: null,
      outcome: null,
      reportId: null,
    };
  }

  // ---- Gather the state the two functions need --------------------------
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
    ? Math.round((startOfDay(raceDate).getTime() - startOfDay(now).getTime()) / 86400000)
    : null;

  // Load already planned inside the constrained window, per discipline.
  const plannedByDiscipline: Record<string, number> = {};
  let mechanicalHeadroom: number | null = null;

  if (plan) {
    const windowSessions = await prisma.plannedSession.findMany({
      where: {
        planId: plan.id,
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
  const outcome = plan
    ? await adaptPlanForUser(userId, {
        now,
        trigger: "athlete_report",
        dryRun: opts.dryRun,
        extraConstraints: [...risk.constraints, ...opportunity.constraints],
        extraPreferences: opportunity.preferences,
      })
    : null;

  // ---- Reply -------------------------------------------------------------
  const reply = await composeReply({
    parsed, risk, opportunity, outcome, daysToRace,
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

/**
 * Composes the reply. The LLM phrases it; every fact in it was decided
 * deterministically above.
 */
async function composeReply(args: {
  parsed: ParsedReport;
  risk: RiskAssessment;
  opportunity: OpportunityPlan;
  outcome: AdaptationOutcome | null;
  daysToRace: number | null;
}): Promise<string> {
  const { parsed, risk, opportunity, outcome } = args;

  const deterministic: string[] = [];
  if (risk.decision === "rest") {
    deterministic.push("Today becomes a rest day.");
  } else if (risk.decision === "easy_only") {
    deterministic.push("Intensity is capped until this settles — easy only.");
  } else if (risk.decision === "downgrade") {
    deterministic.push("Sessions are eased back.");
  }
  deterministic.push(...opportunity.rationale);
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

  const fallback = deterministic.join(" ");

  // With nothing moved, the narrator's stock line would be "no changes were
  // needed" — which hides the reasoning above. Use our own words instead.
  if (!outcome?.changes?.length) return fallback;

  return narrate({
    trigger: "athlete_report",
    constraints: [...risk.constraints, ...opportunity.constraints],
    diff: {
      empty: !outcome?.changes?.length,
      changes: outcome?.changes ?? [],
    },
    facts: {
      whatTheySaid: parsed,
      riskAssessment: risk.facts,
      opportunity: opportunity.facts,
      decisionsAlreadyMade: deterministic,
    },
  }).catch(() => fallback);
}

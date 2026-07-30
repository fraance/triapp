/**
 * The adaptation engine orchestrator (spec Part 4).
 *
 * Pipeline:  sense -> interpret (signals) -> solve -> commit (hysteresis) -> explain
 *
 * This is the only module that writes to the plan, and the only one that talks
 * to the database. Everything it depends on is a pure function, so any decision
 * can be reproduced exactly from the inputs recorded in the Adaptation row.
 */
import { createHash } from "node:crypto";
import { prisma } from "../prisma";
import {
  Constraint,
  LoadVector,
  PlanDiff,
  Preference,
  SessionChange,
  SolverSession,
  ZERO_LOAD,
} from "./types";
import {
  dailySeries,
  ewma,
  loadVectorFor,
  normaliseDiscipline,
  sumLoad,
  totalLoad,
} from "./load-vector";
import { executionDriftEngine, fatiguePressure, CompletedSession } from "./signals";
import { solve } from "./solver";
import { GuardrailContext } from "./guardrails";
import { narrate } from "./narrator";
import { startOfDay } from "../plan-dates";

/** How much better a plan must be before we disturb the athlete (spec 4.4). */
const HYSTERESIS_FACTOR = 1.08;

/** Local hour after which tomorrow's sessions are locked (spec 4.4). */
const FREEZE_HOUR = 20;

/** How far ahead the solver may reshuffle. */
const HORIZON_DAYS = 10;

export interface AdaptationOutcome {
  ran: boolean;
  outcome:
    | "applied"
    | "no_change"
    | "rejected_hysteresis"
    | "blocked_frozen"
    | "no_plan"
    | "skipped";
  reason?: string;
  changes?: SessionChange[];
  explanation?: string;
  scoreBefore?: number;
  scoreAfter?: number;
  adaptationId?: string;
}

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/**
 * The date up to which sessions are locked.
 * Before 20:00 only today is frozen; after 20:00 tomorrow locks too.
 */
export function freezeBoundary(now: Date): string {
  return now.getHours() >= FREEZE_HOUR ? iso(addDays(now, 1)) : iso(now);
}

/**
 * Runs the full pipeline for one athlete.
 *
 * @param now injectable so tests are not at the mercy of the wall clock.
 */
export async function adaptPlanForUser(
  userId: string,
  opts: { now?: Date; trigger?: string; dryRun?: boolean } = {}
): Promise<AdaptationOutcome> {
  const now = opts.now ?? new Date();
  const trigger = opts.trigger ?? "strava_sync";
  const today = iso(startOfDay(now));

  const plan = await prisma.trainingPlan.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: { id: true, startDate: true, targetRaceDate: true },
  });
  if (!plan) return { ran: false, outcome: "no_plan", reason: "no training plan" };

  // ---- Sense ------------------------------------------------------------
  const horizonEnd = iso(addDays(startOfDay(now), HORIZON_DAYS));

  const rows = await prisma.plannedSession.findMany({
    where: {
      planId: plan.id,
      scheduledDate: {
        gte: startOfDay(now),
        lte: addDays(startOfDay(now), HORIZON_DAYS),
      },
    },
    orderBy: { scheduledDate: "asc" },
  });

  if (rows.length === 0) {
    return { ran: false, outcome: "no_plan", reason: "no sessions in the horizon" };
  }

  const sessions: SolverSession[] = rows
    .filter((r) => r.status === "planned")
    .map((r) => ({
      id: r.id,
      date: iso(r.scheduledDate!),
      discipline: r.discipline,
      type: r.type,
      durationMinutes: parseMinutes(r.duration),
      tss: r.tss,
      load: loadVectorFor({ discipline: r.discipline, tss: r.tss, type: r.type }),
      purpose: r.purpose ?? r.type,
      isAnchor: r.isAnchor,
      status: r.status,
    }));

  if (sessions.length === 0) {
    return { ran: false, outcome: "no_change", reason: "nothing left to adapt" };
  }

  // Completed training, for drift and chronic load.
  const activities = await prisma.stravaActivity.findMany({
    where: { userId, startDate: { gte: addDays(startOfDay(now), -60) } },
    orderBy: { startDate: "asc" },
    select: {
      startDate: true,
      discipline: true,
      estimatedTss: true,
      name: true,
      distance: true,
      elevationGain: true,
    },
  });

  const completedLoads = activities.map((a) => ({
    date: iso(a.startDate),
    load: loadVectorFor({
      discipline: a.discipline,
      tss: a.estimatedTss,
      type: a.name,
      distanceKm: a.distance ? a.distance / 1000 : null,
      elevationGainM: a.elevationGain,
    }),
  }));

  const chronicLoad = ewma(
    dailySeries(completedLoads, iso(addDays(startOfDay(now), -60)), today),
    42
  );
  const acuteLoad = ewma(
    dailySeries(completedLoads, iso(addDays(startOfDay(now), -7)), today),
    7
  );
  const previousWeekLoad = sumLoad(
    completedLoads
      .filter((c) => c.date >= iso(addDays(startOfDay(now), -7)) && c.date < today)
      .map((c) => c.load)
  );

  // Match completed activities to what had been planned that day, so drift is
  // measured against intent rather than against nothing.
  const plannedRecent = await prisma.plannedSession.findMany({
    where: {
      planId: plan.id,
      scheduledDate: { gte: addDays(startOfDay(now), -4), lt: startOfDay(now) },
    },
    select: { scheduledDate: true, discipline: true, tss: true, type: true },
  });

  const completed: CompletedSession[] = completedLoads
    .filter((c) => c.date >= iso(addDays(startOfDay(now), -4)) && c.date < today)
    .map((c) => {
      const match = plannedRecent.find(
        (p) =>
          iso(p.scheduledDate!) === c.date &&
          normaliseDiscipline(p.discipline) ===
            normaliseDiscipline(disciplineOf(c.load, activities, c.date))
      );
      return {
        date: c.date,
        discipline: "",
        actualLoad: c.load,
        plannedLoad: match
          ? loadVectorFor({ discipline: match.discipline, tss: match.tss, type: match.type })
          : undefined,
      };
    });

  // ---- Interpret --------------------------------------------------------
  const drift = executionDriftEngine(completed, today);

  const constraints: Constraint[] = [...drift.constraints];
  const preferences: Preference[] = [
    ...drift.preferences,
    {
      source: "engine",
      reason: "A stable plan is easier to follow than an optimal one.",
      key: "prefer_fewer_changes",
      weight: 3,
    },
  ];

  // Nothing to react to — do not churn the plan.
  if (constraints.filter((c) => c.type === "hard").length === 0) {
    return {
      ran: true,
      outcome: "no_change",
      reason: "recent training matched the plan",
    };
  }

  // ---- Solve ------------------------------------------------------------
  const guardrails: GuardrailContext = {
    chronicLoad,
    previousWeekLoad,
  };

  const frozenUntil = freezeBoundary(now);

  const input = {
    today,
    sessions,
    constraints,
    preferences,
    chronicLoad,
    frozenUntil,
  };

  const before = solveScore(input, guardrails);
  const result = solve(input, { guardrails });

  const diff = diffPlans(sessions, result.sessions);

  if (diff.empty) {
    return { ran: true, outcome: "no_change", reason: "the current plan is already best" };
  }

  // ---- Commit: hysteresis (spec 4.4) ------------------------------------
  // Only disturb the athlete if the new plan is materially better. The one
  // exception is an illegal current plan — a guardrail breach must be fixed.
  const currentIsLegal = before.legal;
  const materiallyBetter = result.score > before.score * HYSTERESIS_FACTOR;

  const inputHash = createHash("sha256")
    .update(JSON.stringify({ today, sessions, constraints }))
    .digest("hex")
    .slice(0, 16);

  if (currentIsLegal && !materiallyBetter) {
    await recordAdaptation({
      userId,
      planId: plan.id,
      trigger,
      cause: { constraints, facts: drift.facts },
      diff,
      scoreBefore: before.score,
      scoreAfter: result.score,
      inputHash,
      explanation:
        "A change was considered but not made: the improvement was too small to be worth disrupting the week.",
      outcome: "rejected_hysteresis",
    });
    return {
      ran: true,
      outcome: "rejected_hysteresis",
      reason: `improvement below the ${Math.round((HYSTERESIS_FACTOR - 1) * 100)}% threshold`,
      scoreBefore: before.score,
      scoreAfter: result.score,
    };
  }

  // ---- Explain ----------------------------------------------------------
  const explanation = await narrate({
    trigger,
    constraints,
    diff,
    facts: drift.facts,
  });

  if (opts.dryRun) {
    return {
      ran: true,
      outcome: "applied",
      reason: "dry run — nothing written",
      changes: diff.changes,
      explanation,
      scoreBefore: before.score,
      scoreAfter: result.score,
    };
  }

  // ---- Apply, versioned -------------------------------------------------
  const version = await snapshotPlan(plan.id, rows);

  for (const s of result.sessions) {
    const original = sessions.find((o) => o.id === s.id)!;
    const moved = s.date !== original.date;
    const scaled = (s.scaledBy ?? 1) !== 1;
    if (!moved && !scaled && !s.dropped) continue;

    await prisma.plannedSession.update({
      where: { id: s.id },
      data: {
        scheduledDate: s.dropped ? undefined : new Date(s.date + "T00:00:00"),
        day: s.dropped ? undefined : weekdayName(s.date),
        tss: s.dropped ? undefined : Math.round(s.tss),
        status: s.dropped ? "skipped" : "adapted",
        adaptedAt: now,
      },
    });
  }

  const adaptation = await recordAdaptation({
    userId,
    planId: plan.id,
    versionId: version.id,
    trigger,
    cause: { constraints, facts: drift.facts },
    diff,
    scoreBefore: before.score,
    scoreAfter: result.score,
    inputHash,
    explanation,
    outcome: "applied",
  });

  return {
    ran: true,
    outcome: "applied",
    changes: diff.changes,
    explanation,
    scoreBefore: before.score,
    scoreAfter: result.score,
    adaptationId: adaptation.id,
  };
}

// ---- helpers --------------------------------------------------------------

function solveScore(
  input: Parameters<typeof solve>[0],
  guardrails: GuardrailContext
): { score: number; legal: boolean } {
  const r = solve({ ...input }, { guardrails, maxDepth: 0 });
  return { score: r.score, legal: r.violations.length === 0 };
}

/** Works out which activity produced a load vector on a given date. */
function disciplineOf(
  _load: LoadVector,
  activities: Array<{ startDate: Date; discipline: string }>,
  date: string
): string {
  const match = activities.find((a) => iso(a.startDate) === date);
  return match?.discipline ?? "";
}

export function diffPlans(
  before: SolverSession[],
  after: SolverSession[]
): PlanDiff {
  const changes: SessionChange[] = [];

  for (const b of before) {
    const a = after.find((x) => x.id === b.id);
    if (!a) continue;

    if (a.dropped) {
      changes.push({
        sessionId: b.id,
        discipline: b.discipline,
        change: "dropped",
        fromDate: b.date,
        fromTss: b.tss,
      });
      continue;
    }
    if (a.date !== b.date) {
      changes.push({
        sessionId: b.id,
        discipline: b.discipline,
        change: "moved",
        fromDate: b.date,
        toDate: a.date,
      });
    }
    if (Math.round(a.tss) !== Math.round(b.tss)) {
      changes.push({
        sessionId: b.id,
        discipline: b.discipline,
        change: "scaled",
        fromDate: b.date,
        toDate: a.date,
        fromTss: Math.round(b.tss),
        toTss: Math.round(a.tss),
      });
    }
  }

  return { changes, empty: changes.length === 0 };
}

async function snapshotPlan(planId: string, rows: unknown[]) {
  const last = await prisma.planVersion.findFirst({
    where: { planId },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  return prisma.planVersion.create({
    data: {
      planId,
      version: (last?.version ?? 0) + 1,
      snapshot: JSON.parse(JSON.stringify(rows)),
    },
  });
}

async function recordAdaptation(args: {
  userId: string;
  planId: string;
  versionId?: string;
  trigger: string;
  cause: unknown;
  diff: PlanDiff;
  scoreBefore: number;
  scoreAfter: number;
  inputHash: string;
  explanation: string;
  outcome: string;
}) {
  return prisma.adaptation.create({
    data: {
      userId: args.userId,
      planId: args.planId,
      versionId: args.versionId,
      trigger: args.trigger,
      cause: JSON.parse(JSON.stringify(args.cause)),
      diff: JSON.parse(JSON.stringify(args.diff)),
      scoreBefore: args.scoreBefore,
      scoreAfter: args.scoreAfter,
      inputHash: args.inputHash,
      explanation: args.explanation,
      outcome: args.outcome,
    },
  });
}

function parseMinutes(duration: string): number {
  const m = /(\d+)\s*(min|h)/i.exec(duration || "");
  if (!m) return 0;
  const n = Number(m[1]);
  return /h/i.test(m[2]) ? n * 60 : n;
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

function weekdayName(isoDate: string): string {
  return WEEKDAYS[new Date(isoDate + "T00:00:00").getDay()];
}

/** Most recent adaptations for an athlete, for the Today screen. */
export async function recentAdaptations(userId: string, limit = 10) {
  return prisma.adaptation.findMany({
    where: { userId, outcome: "applied" },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      trigger: true,
      explanation: true,
      diff: true,
      createdAt: true,
    },
  });
}

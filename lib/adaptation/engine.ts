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
import {
  executionDriftEngine,
  crossSportSwapEngine,
  fatiguePressure,
  CompletedSession,
} from "./signals";
import { dailyPlannedVsActual, reconcilePlanWithActivities } from "./reconcile";
import { planNextWeek, selectAnchors, MacroState, WeekSummary } from "./macro-planner";
import {
  weeklyHoursFrom,
  fitsOn as fitsOnDate,
  datesThatFit,
  unavailableDates,
  preferredLongDates,
  describeAvailability,
} from "./availability-window";
import { solve } from "./solver";
import { GuardrailContext } from "./guardrails";
import { analyseLimiters, describeLimiters, LimiterAnalysis } from "./limiter";
import { getThresholdRecord, observationsFor } from "./thresholds";
import { applyCompletedTests } from "./test-feedback";
import { planTestInjections } from "./test-injection";
import type { ThresholdKind } from "./physiology";
import {
  thresholdConfidence,
  buildThresholdReport,
  metabolicState,
  metabolicEngine,
  ThresholdConfidence,
} from "./physiology";
import { narrate } from "./narrator";
import { startOfDay } from "../plan-dates";

/** How much better a plan must be before we disturb the athlete (spec 4.4). */
const HYSTERESIS_FACTOR = 1.08;

/** Local hour after which tomorrow's sessions are locked (spec 4.4). */
const FREEZE_HOUR = 20;

/** How far ahead the solver may reshuffle. */
const HORIZON_DAYS = 10;

/** A session at or above this length is treated as a long session (v3 §4.3). */
const LONG_SESSION_MINUTES = 120;

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
  /** How the past week's log was updated to match reality. */
  reconciled?: { completed: number; substituted: number; missed: number };
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
  opts: {
    now?: Date;
    trigger?: string;
    dryRun?: boolean;
    /**
     * Constraints from outside the routine signal engines — currently the
     * athlete's own reported state and logistics. They join the same pipeline
     * as everything else, so a chat message is subject to identical guardrails.
     */
    extraConstraints?: Constraint[];
    extraPreferences?: Preference[];
  } = {}
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

  // ---- Reconcile first --------------------------------------------------
  // The plan must reflect reality before we reason about it. Without this the
  // week's log stayed at "planned" forever and the drift engine had nothing to
  // compare against, so the plan never adapted.
  const reconciled = await reconcilePlanWithActivities(userId, {
    now,
    dryRun: opts.dryRun,
  });

  // ---- Sense ------------------------------------------------------------
  // Make sure each upcoming week has key sessions the solver may not sacrifice
  // (v3 Part 3.2). Without this nothing is protected and the engine is free to
  // dismantle the week's most important workouts.
  // A completed test must update the threshold before anything reads it,
  // otherwise the engine spends a cycle reasoning from the number the test
  // just replaced.
  const testResults = opts.dryRun ? [] : await applyCompletedTests(userId, { now });
  for (const r of testResults.filter((r) => r.applied)) {
    console.log(
      `[thresholds] ${r.kind}: ${r.previous ?? "none"} -> ${r.value} (${r.method})`
    );
  }

  // v3 §3.1: rank disciplines by where race time is actually won on this
  // course, so key sessions and salvage decisions follow return on investment.
  const limiters = await analyseLimitersFor(userId);

  if (!opts.dryRun) await ensureAnchors(plan.id, now, limiters.priority);

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
    return {
      ran: false,
      outcome: "no_plan",
      reason: "no sessions in the horizon",
      reconciled: summarise(reconciled),
    };
  }

  const sessions: SolverSession[] = rows
    // "adapted" must be included. Filtering to "planned" alone froze every
    // session the engine had already touched out of all future adaptations —
    // and out of the weekly ramp guardrail, so the week's real total was
    // understated.
    .filter((r) => r.status === "planned" || r.status === "adapted")
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
      // v3 §4.3: 2h+ sessions, and anything named "long", are pinned to the
      // days real life allows and are never shuffled onto a weekday.
      isLong:
        parseMinutes(r.duration) >= LONG_SESSION_MINUTES ||
        /long/i.test(r.type ?? ""),
      status: r.status,
    }));

  if (sessions.length === 0) {
    return {
      ran: false,
      outcome: "no_change",
      reason: "nothing left to adapt",
      reconciled: summarise(reconciled),
    };
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

  // Compare what was planned against what was done **per day**, not per
  // discipline. Pairing like with like made the most important case invisible:
  // if a run was swapped for a ride, neither side matched, so the engine
  // concluded there was nothing comparable and left the plan untouched.
  const dayPairs = await dailyPlannedVsActual(userId, { now, days: 4 });

  const completed: CompletedSession[] = dayPairs.map((d) => ({
    date: d.date,
    discipline: "",
    actualLoad: sumLoad(d.actualLoad),
    // A planned day with nothing done is a real signal (load shortfall), so
    // the planned side is always supplied when the day had a plan.
    plannedLoad: d.plannedLoad.length > 0 ? sumLoad(d.plannedLoad) : undefined,
  }));

  // ---- Interpret --------------------------------------------------------
  const drift = executionDriftEngine(completed, today);

  // Weekly intent (v3 Part 3). The drift engine only spans 48 hours, so
  // without this a week that runs hot is damped for two days and then carries
  // on unchanged. Load debt is never repaid — see macro-planner.ts.
  const macro = await planWeeklyIntent(userId, plan.id, now, chronicLoad);

  // Cross-sport swaps load the legs in ways the plan never budgeted for.
  const swap = crossSportSwapEngine(reconciled.swaps ?? [], today);

  // v3 §2.1: estimated glycogen from trailing 48-hour load, as a fuelling
  // constraint. Depleted stores do not stop training — they change what
  // training is useful, so intensity is capped rather than volume.
  const metabolic = metabolicState(completedLoads, now);
  const fuelling = metabolicEngine(metabolic, today);

  // v3 §2.1: how much the coach may trust its own numbers.
  const thresholds = await thresholdReportFor(userId, now);

  const constraints: Constraint[] = [
    ...drift.constraints,
    ...swap.constraints,
    ...fuelling.constraints,
    ...macro.constraints,
    ...(opts.extraConstraints ?? []),
  ];
  const preferences: Preference[] = [
    ...(opts.extraPreferences ?? []),
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
      reconciled: summarise(reconciled),
    };
  }

  // ---- Solve ------------------------------------------------------------
  // v3 §4.3: the athlete's declared hours decide when a long session can
  // happen. Previously this was inferred from weekends, which is a guess and
  // wrong for anyone who trains midweek or works Saturdays.
  const availabilityRecord = await prisma.trainingAvailability.findUnique({
    where: { userId },
  });
  const availability = weeklyHoursFrom(availabilityRecord);

  // The longest session in the horizon sets the bar for what a day must hold.
  const longestMinutes = Math.max(
    0,
    ...sessions.filter((s) => s.isLong).map((s) => s.durationMinutes)
  );
  // Every day that can actually hold a long session. The athlete's stated
  // preferred day is a *preference*, not a restriction: treating it as the only
  // legal day made a long session that had to move unplaceable, and the whole
  // week unsolvable.
  const longDates = datesThatFit(availability, today, HORIZON_DAYS, longestMinutes);
  const preferred = preferredLongDates(availability, today, HORIZON_DAYS, longestMinutes);
  if (preferred.length > 0) {
    preferences.push({
      source: "availability",
      reason: `You prefer your long session on ${availabilityRecord?.longSessionDay}.`,
      key: "prefer_long_session_day",
      weight: 2,
    });
  }
  const noTimeDates = unavailableDates(availability, today, HORIZON_DAYS);

  // v3 §3.4: schedule tests for thresholds we can no longer trust. A test
  // replaces a quality session rather than being added on top, so injecting
  // one can never breach the weekly ramp.
  if (!opts.dryRun) {
    await injectTests(userId, plan.id, thresholds.thresholds, {
      today,
      raceDate: iso(plan.targetRaceDate),
      frozenUntil: freezeBoundary(now),
      fits: (date, minutes) =>
        !availability.isSet || fitsOnDate(availability, date, minutes),
    });
  }

  // v3 §5 Cold Start Trap: count days we actually hold training data for.
  // Below 28 days the ACWR denominator is untrustworthy and would zero out the
  // athlete's week, so a daily ceiling governs instead.
  const historyDates = new Set(completedLoads.map((c) => c.date));
  const chronicHistoryDays = historyDates.size;

  const guardrails: GuardrailContext = {
    chronicLoad,
    previousWeekLoad,
    chronicHistoryDays,
    // Fallback ceiling from what the athlete has actually been doing, not an
    // invented number: their busiest recent day, with a little headroom.
    dailyLoadCeiling: dailyCeilingFrom(completedLoads),
    // Fall back to where long sessions already sit only when the athlete has
    // declared nothing — never invent a limit they did not give us.
    longSessionDates: availability.isSet
      ? longDates
      : longSessionDatesFrom(sessions),
  };

  const frozenUntil = freezeBoundary(now);

  // Constraints must not target days the solver is forbidden to touch.
  // Drift constraints naturally start "today", but today is inside the
  // commitment window, so the constraint could never be satisfied: the plan
  // stayed permanently illegal and the engine reported "no change" while
  // actually being stuck. Clamp each constraint to the first adaptable day.
  const firstAdaptable = iso(addDays(new Date(frozenUntil + "T00:00:00"), 1));
  const clamped = constraints.map((c) =>
    c.fromDate && c.fromDate <= frozenUntil
      ? { ...c, fromDate: firstAdaptable }
      : c
  );

  const input = {
    today,
    sessions,
    constraints: clamped,
    preferences,
    chronicLoad,
    frozenUntil,
    unavailableDates: noTimeDates,
    longSessionDates: availability.isSet ? longDates : undefined,
    availableMinutesByDate: availability.isSet
      ? availableMinutesMap(availability, today, HORIZON_DAYS)
      : undefined,
  };

  const before = solveScore(input, guardrails);
  const result = solve(input, { guardrails });

  const diff = diffPlans(sessions, result.sessions);

  const inputHash = createHash("sha256")
    .update(JSON.stringify({ today, sessions, constraints: clamped }))
    .digest("hex")
    .slice(0, 16);

  // If the plan still breaks a hard rule and the solver could not repair it,
  // say so. Reporting "no change" here would hide a real problem behind a
  // reassuring message.
  if (result.violations.length > 0) {
    await recordAdaptation({
      userId,
      planId: plan.id,
      trigger,
      cause: {
        constraints: clamped,
        facts: {
          ...drift.facts,
          swap: swap.facts,
          availability: describeAvailability(availability),
          metabolic: fuelling.facts,
          thresholds: {
            rpeOnly: thresholds.rpeOnly,
            testsNeeded: thresholds.testsNeeded,
            summary: thresholds.summary,
          },
          limiters: limiters.hasData
            ? { ranked: limiters.ranked, priority: limiters.priority }
            : null,
          macro: macro.facts,
          macroAction: macro.action,
        },
      },
      diff,
      scoreBefore: before.score,
      scoreAfter: result.score,
      inputHash,
      explanation:
        "Your plan needs to change but no safe version could be found within " +
        "the locked days: " + result.violations.slice(0, 3).join("; "),
      outcome: "blocked_frozen",
    });
    return {
      ran: true,
      outcome: "blocked_frozen",
      reason: result.violations.slice(0, 3).join("; "),
      reconciled: summarise(reconciled),
      scoreBefore: before.score,
      scoreAfter: result.score,
    };
  }

  if (diff.empty) {
    return {
      ran: true,
      outcome: "no_change",
      reason: "the current plan is already best",
      reconciled: summarise(reconciled),
    };
  }

  // ---- Commit: hysteresis (spec 4.4) ------------------------------------
  // Only disturb the athlete if the new plan is materially better. The one
  // exception is an illegal current plan — a guardrail breach must be fixed.
  const currentIsLegal = before.legal;
  const materiallyBetter = result.score > before.score * HYSTERESIS_FACTOR;

  if (currentIsLegal && !materiallyBetter) {
    await recordAdaptation({
      userId,
      planId: plan.id,
      trigger,
      cause: {
        constraints: clamped,
        facts: {
          ...drift.facts,
          swap: swap.facts,
          availability: describeAvailability(availability),
          metabolic: fuelling.facts,
          thresholds: {
            rpeOnly: thresholds.rpeOnly,
            testsNeeded: thresholds.testsNeeded,
            summary: thresholds.summary,
          },
          limiters: limiters.hasData
            ? { ranked: limiters.ranked, priority: limiters.priority }
            : null,
          macro: macro.facts,
          macroAction: macro.action,
        },
      },
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
      reconciled: summarise(reconciled),
      reason: `improvement below the ${Math.round((HYSTERESIS_FACTOR - 1) * 100)}% threshold`,
      scoreBefore: before.score,
      scoreAfter: result.score,
    };
  }

  // ---- Explain ----------------------------------------------------------
  const explanation = await narrate({
    trigger,
    constraints: clamped,
    diff,
    facts: { ...drift.facts, weeklyIntent: macro.reason },
  });

  if (opts.dryRun) {
    return {
      ran: true,
      outcome: "applied",
      reason: "dry run — nothing written",
      reconciled: summarise(reconciled),
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
        duration: s.dropped ? undefined : `${Math.round(s.durationMinutes)} min`,
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
    cause: {
        constraints: clamped,
        facts: {
          ...drift.facts,
          swap: swap.facts,
          availability: describeAvailability(availability),
          metabolic: fuelling.facts,
          thresholds: {
            rpeOnly: thresholds.rpeOnly,
            testsNeeded: thresholds.testsNeeded,
            summary: thresholds.summary,
          },
          limiters: limiters.hasData
            ? { ranked: limiters.ranked, priority: limiters.priority }
            : null,
          macro: macro.facts,
          macroAction: macro.action,
        },
      },
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
    reconciled: summarise(reconciled),
    changes: diff.changes,
    explanation,
    scoreBefore: before.score,
    scoreAfter: result.score,
    adaptationId: adaptation.id,
  };
}

/**
 * Marks 2–3 anchor sessions per upcoming week, if none are set yet.
 * Idempotent, and never demotes an anchor the engine already chose.
 */
export async function ensureAnchors(
  planId: string,
  now: Date,
  priority?: Record<string, number>
): Promise<number> {
  const from = startOfDay(now);
  const to = addDays(from, 21);
  const rows = await prisma.plannedSession.findMany({
    where: { planId, scheduledDate: { gte: from, lte: to }, status: "planned" },
    select: { id: true, week: true, discipline: true, tss: true, isAnchor: true },
  });

  const byWeek = new Map<number, typeof rows>();
  for (const r of rows) byWeek.set(r.week, [...(byWeek.get(r.week) ?? []), r]);

  let marked = 0;
  for (const [, weekRows] of byWeek) {
    if (weekRows.some((r) => r.isAnchor)) continue; // already decided
    const ids = selectAnchors(weekRows, 3, priority);
    if (ids.length === 0) continue;
    await prisma.plannedSession.updateMany({
      where: { id: { in: ids } },
      data: { isAnchor: true },
    });
    marked += ids.length;
  }
  return marked;
}

// ---- Weekly intent --------------------------------------------------------

/**
 * Builds the macro planner's view: what each recent week planned vs achieved,
 * and what the coming week currently asks for.
 */
async function planWeeklyIntent(
  userId: string,
  planId: string,
  now: Date,
  chronicLoad: LoadVector
) {
  const monday = mondayOf(startOfDay(now));
  const historyStart = addDays(monday, -28);

  const sessions = await prisma.plannedSession.findMany({
    where: { planId, scheduledDate: { gte: historyStart, lt: addDays(monday, 14) } },
    select: { scheduledDate: true, discipline: true, type: true, tss: true, status: true },
  });

  const activities = await prisma.stravaActivity.findMany({
    where: { userId, startDate: { gte: historyStart, lt: addDays(monday, 7) } },
    select: { startDate: true, discipline: true, name: true, estimatedTss: true },
  });

  const history: WeekSummary[] = [];
  // i = 0 is the current week. It must be included: when the coming week is
  // planned, the week that just happened is the most informative input, and
  // excluding it meant the cap was set from stale or absent history.
  for (let i = 4; i >= 0; i--) {
    const wkStart = addDays(monday, -7 * i);
    const wkEnd = addDays(wkStart, 7);
    const planned = sessions
      .filter((s) => s.scheduledDate && s.scheduledDate >= wkStart && s.scheduledDate < wkEnd)
      .reduce(
        (n, s) =>
          n + totalLoad(loadVectorFor({ discipline: s.discipline, tss: s.tss, type: s.type })),
        0
      );
    const actual = activities
      .filter((a) => a.startDate >= wkStart && a.startDate < wkEnd)
      .reduce(
        (n, a) =>
          n +
          totalLoad(
            loadVectorFor({ discipline: a.discipline, tss: a.estimatedTss, type: a.name })
          ),
        0
      );
    if (planned > 0 || actual > 0) {
      history.push({ weekStart: iso(wkStart), plannedLoad: planned, actualLoad: actual });
    }
  }

  const nextStart = addDays(monday, 7);
  const nextEnd = addDays(nextStart, 7);
  const nextWeekPlanned = sessions
    .filter((s) => s.scheduledDate && s.scheduledDate >= nextStart && s.scheduledDate < nextEnd)
    .reduce(
      (n, s) =>
        n + totalLoad(loadVectorFor({ discipline: s.discipline, tss: s.tss, type: s.type })),
      0
    );

  const state: MacroState = {
    history,
    chronicLoad,
    nextWeekPlanned,
    nextWeekStart: iso(nextStart),
  };

  return planNextWeek(state);
}

/**
 * Days a long session may occupy. Until per-day availability is wired in, this
 * is where long sessions already sit plus the weekends in the horizon — so the
 * solver can never quietly relocate a weekend session to a Tuesday morning.
 */
function longSessionDatesFrom(sessions: SolverSession[]): string[] {
  const dates = new Set<string>();
  for (const s of sessions) {
    if (s.isLong) dates.add(s.date);
    const day = new Date(s.date + "T00:00:00").getDay();
    if (day === 0 || day === 6) dates.add(s.date);
  }
  return [...dates].sort();
}

/** Daily load ceiling used only while chronic history is too short. */
function dailyCeilingFrom(loads: Array<{ date: string; load: LoadVector }>): number {
  if (loads.length === 0) return 0;
  const byDay = new Map<string, number>();
  for (const l of loads) {
    byDay.set(l.date, (byDay.get(l.date) ?? 0) + totalLoad(l.load));
  }
  const busiest = Math.max(...byDay.values());
  return Math.round(busiest * 1.1);
}

/**
 * Turns test-injection decisions into real sessions.
 *
 * The chosen session is rewritten in place rather than a new one added: the
 * test IS the session. Its original shape is kept in `originalTss` so the
 * change remains explainable.
 */
async function injectTests(
  userId: string,
  planId: string,
  confidences: ThresholdConfidence[],
  ctx: {
    today: string;
    raceDate: string | null;
    frozenUntil: string;
    fits: (date: string, minutes: number) => boolean;
  }
): Promise<number> {
  const needing = confidences.filter((c) => c.needsTest);
  if (needing.length === 0) return 0;

  const equipment = await equipmentFor(userId);

  // Tests the athlete has already declined. Re-offering them daily is the
  // interrogation v3's North Star forbids.
  const prefsRow = await prisma.athleteProfile.findUnique({
    where: { userId },
    select: { testPreferences: true },
  });
  const declined: Partial<Record<ThresholdKind, string>> = {};
  if (prefsRow?.testPreferences && typeof prefsRow.testPreferences === "object") {
    for (const [k, v] of Object.entries(prefsRow.testPreferences as Record<string, any>)) {
      if (v && typeof v.declinedAt === "string") {
        declined[k as ThresholdKind] = v.declinedAt.slice(0, 10);
      }
    }
  }

  const rows = await prisma.plannedSession.findMany({
    where: {
      planId,
      scheduledDate: { gte: new Date(ctx.today + "T00:00:00") },
      status: { in: ["planned", "adapted"] },
    },
    orderBy: { scheduledDate: "asc" },
    select: {
      id: true, scheduledDate: true, discipline: true, type: true, tss: true,
      duration: true, isAnchor: true, status: true, isTest: true,
    },
  });

  const existingTests = await prisma.plannedSession.findMany({
    where: { planId, isTest: true },
    select: { scheduledDate: true },
  });

  const candidates = planTestInjections(needing, {
    today: ctx.today,
    equipment,
    fits: ctx.fits,
    raceDate: ctx.raceDate,
    frozenUntil: ctx.frozenUntil,
    declined,
    existingTestDates: existingTests
      .map((t) => (t.scheduledDate ? iso(t.scheduledDate) : null))
      .filter((d): d is string => d !== null),
    slots: rows.map((r) => ({
      id: r.id,
      date: iso(r.scheduledDate!),
      discipline: r.discipline,
      type: r.type,
      tss: r.tss,
      durationMinutes: parseMinutes(r.duration),
      isAnchor: r.isAnchor,
      status: r.status,
      isTest: r.isTest,
    })),
  });

  for (const c of candidates) {
    const original = rows.find((r) => r.id === c.replaceSessionId);
    await prisma.plannedSession.update({
      where: { id: c.replaceSessionId },
      data: {
        isTest: true,
        testKind: c.kind,
        testMode: c.mode,
        type: "Test",
        discipline: c.protocol.discipline,
        duration: `${c.protocol.durationMinutes} min`,
        tss: c.protocol.tss,
        instructions: c.protocol.instructions,
        purpose: `Re-establish ${c.protocol.kind}`,
        originalTss: original?.tss ?? null,
        adaptedAt: new Date(),
      },
    });
    console.log(`[thresholds] injected ${c.protocol.name} on ${c.date}: ${c.reason}`);
  }

  return candidates.length;
}

/** What the athlete can actually measure with. */
async function equipmentFor(userId: string) {
  const [withPower, availability] = await Promise.all([
    prisma.stravaActivity.count({
      where: { userId, avgWatts: { not: null }, discipline: "Bike" },
    }),
    prisma.trainingAvailability.findUnique({
      where: { userId },
      select: { poolAccess: true },
    }),
  ]);
  const withHr = await prisma.stravaActivity.count({
    where: { userId, avgHeartRate: { not: null } },
  });
  return {
    // Evidence, not assumption: a power meter is present if rides carry power.
    powerMeter: withPower >= 3,
    heartRateMonitor: withHr >= 3,
    pool: availability?.poolAccess ?? false,
  };
}

/**
 * Threshold confidence for every number the coach prescribes from.
 *
 * Observation dates come from real evidence: when the profile was last
 * updated, and the athlete's actual sessions in that discipline. A threshold
 * we cannot date is treated as untrusted rather than assumed fresh — a stale
 * number produces confident, precise, wrong paces.
 */
async function thresholdReportFor(userId: string, now: Date) {
  const [profile, activities] = await Promise.all([
    prisma.athleteProfile.findUnique({
      where: { userId },
      select: {
        ftpWatts: true,
        swimCssSecPer100: true,
        runThresholdPaceSec: true,
        maxHeartRate: true,
        thresholdHeartRate: true,
        updatedAt: true,
      },
    }),
    prisma.stravaActivity.findMany({
      where: { userId, startDate: { gte: addDays(startOfDay(now), -180) } },
      select: { startDate: true, discipline: true, avgWatts: true, avgHeartRate: true },
    }),
  ]);

  if (!profile) return buildThresholdReport([]);

  // Anchored on when each threshold was actually established, from
  // `thresholdsMeasuredAt`. Never on profile.updatedAt, which moves on any
  // profile write and would credit numbers nobody has re-established.
  const record = await getThresholdRecord(userId);

  const dates = (d: string) =>
    activities.filter((a) => normaliseDiscipline(a.discipline) === d).map((a) => a.startDate);
  const hrDates = activities.filter((a) => a.avgHeartRate != null).map((a) => a.startDate);

  const entries: ThresholdConfidence[] = [
    thresholdConfidence("ftp", profile.ftpWatts, observationsFor("ftp", record, dates("bike")), now),
    thresholdConfidence("css", profile.swimCssSecPer100, observationsFor("css", record, dates("swim")), now),
    thresholdConfidence("runThreshold", profile.runThresholdPaceSec, observationsFor("runThreshold", record, dates("run")), now),
    thresholdConfidence("maxHr", profile.maxHeartRate, observationsFor("maxHr", record, hrDates), now),
    thresholdConfidence("thresholdHr", profile.thresholdHeartRate, observationsFor("thresholdHr", record, hrDates), now),
  ];

  return buildThresholdReport(entries);
}

/**
 * Builds the limiter analysis from measured athlete data and the researched
 * race course. Anything unmeasured is left out rather than estimated.
 */
async function analyseLimitersFor(userId: string): Promise<LimiterAnalysis> {
  const [profile, race, rides] = await Promise.all([
    prisma.athleteProfile.findUnique({
      where: { userId },
      select: { swimCssSecPer100: true, runThresholdPaceSec: true, raceType: true },
    }),
    prisma.raceProfile.findUnique({ where: { userId } }),
    prisma.stravaActivity.findMany({
      where: { userId, discipline: "Bike", avgSpeed: { not: null } },
      orderBy: { startDate: "desc" },
      take: 30,
      select: { avgSpeed: true },
    }),
  ]);

  // Median, not mean: one commute or one descent should not define race speed.
  const speeds = rides
    .map((r) => r.avgSpeed!)
    .filter((v) => Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b);
  const bikeSpeedMs = speeds.length > 0 ? speeds[Math.floor(speeds.length / 2)] : null;

  return analyseLimiters(
    {
      swimCssSecPer100: profile?.swimCssSecPer100 ?? null,
      runThresholdPaceSec: profile?.runThresholdPaceSec ?? null,
      bikeSpeedMs,
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
}

/** Minutes available on each date in the horizon, from declared hours. */
function availableMinutesMap(
  availability: ReturnType<typeof weeklyHoursFrom>,
  fromISO: string,
  days: number
): Record<string, number> | undefined {
  if (!availability.isSet || availability.noTimeConstraints) return undefined;
  const out: Record<string, number> = {};
  const cursor = new Date(fromISO + "T00:00:00");
  for (let i = 0; i < days; i++) {
    const key = iso(cursor);
    out[key] = (availability.byWeekday[cursor.getDay()] ?? 0) * 60;
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

function mondayOf(d: Date): Date {
  const x = startOfDay(d);
  const back = (x.getDay() + 6) % 7; // Monday = 0
  return addDays(x, -back);
}

// ---- helpers --------------------------------------------------------------

function summarise(r: { completed: number; substituted: number; missed: number }) {
  return { completed: r.completed, substituted: r.substituted, missed: r.missed };
}

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

/**
 * Sliding Macro Planner (v3 spec Part 3; LOGIC_V2 §2.2, §4.3, §4.4).
 *
 * Maintains a rolling 21-day intent skeleton rather than regenerating a rigid
 * block once a week. Its job is to hold the *week* to an intent, which the
 * daily solver alone cannot do: drift constraints only span 48 hours, so a week
 * that runs hot gets damped for two days and then carries on regardless.
 *
 * The single most important rule here, and the one that is easiest to get
 * dangerously wrong (LOGIC_V2 §4.4):
 *
 *   **Load debt is forgiven by default.** Training below plan NEVER raises a
 *   future week's target, and never adds volume to the long ride or long run
 *   to repay a missed midweek session. That is how age-groupers get injured.
 *   Persistent undershooting means the *plan* was too ambitious, so the plan
 *   comes down — the athlete is not asked to catch up.
 *
 * Overshooting is treated in the opposite direction and is not symmetrical:
 * going over plan tightens the next week's cap and, if the ramp rate is
 * breached, pulls the scheduled recovery week forward (LOGIC_V2 §4.3).
 */
import { Constraint, LoadVector } from "./types";
import { totalLoad } from "./load-vector";

/** LOGIC_V2 §2.3 H3: ΔCTL/week. */
export const RAMP_LIMIT_BUILD = 6;
export const RAMP_LIMIT_OVERLOAD = 8;
/** Max consecutive deliberate overload weeks before recovery is forced. */
export const MAX_CONSECUTIVE_OVERLOAD = 2;

/** A recovery week sits at this fraction of the preceding load. */
export const RECOVERY_WEEK_FACTOR = 0.6;

/** Undershoot beyond this, for this many weeks, lowers the plan (§4.4). */
export const PLAN_DOWNGRADE_SHORTFALL = 0.25;
export const PLAN_DOWNGRADE_WEEKS = 2;

export interface WeekSummary {
  /** ISO date of the Monday. */
  weekStart: string;
  plannedLoad: number;
  actualLoad: number;
}

export interface MacroState {
  /** Week starting today's week, oldest first. Past weeks only. */
  history: WeekSummary[];
  /** Chronic training load (42-day EWMA), per component. */
  chronicLoad: LoadVector;
  /** Planned load for the coming week, before any adjustment. */
  nextWeekPlanned: number;
  /** ISO Monday of the coming week. */
  nextWeekStart: string;
  /** How many consecutive overload weeks have already been taken. */
  consecutiveOverloadWeeks?: number;
}

export interface MacroDecision {
  /** The load the coming week should be held to. */
  targetLoad: number;
  /** Multiplier applied to the planned week. */
  factor: number;
  /** "recovery_week" | "tighten" | "downgrade_plan" | "hold" */
  action: "recovery_week" | "tighten" | "downgrade_plan" | "hold";
  reason: string;
  constraints: Constraint[];
  facts: Record<string, unknown>;
}

/** Weekly ramp actually taken, as a fraction of the previous week. */
function rampOf(prev: number, current: number): number {
  if (prev <= 0) return 0;
  return (current - prev) / prev;
}

/**
 * Decides what the coming week's load should be.
 *
 * Pure function — no database, no clock.
 */
export function planNextWeek(state: MacroState): MacroDecision {
  const { history, nextWeekPlanned, nextWeekStart } = state;
  const weekEnd = addDaysISO(nextWeekStart, 6);

  const recent = history.slice(-4);
  const last = recent[recent.length - 1];

  const facts: Record<string, unknown> = {
    weeksOfHistory: recent.length,
    nextWeekPlanned: Math.round(nextWeekPlanned),
  };

  // Not enough history to reason about — leave the plan alone rather than
  // invent a trend from one week.
  if (!last || last.plannedLoad <= 0) {
    return {
      targetLoad: nextWeekPlanned,
      factor: 1,
      action: "hold",
      reason: "Not enough completed weeks to adjust the plan yet.",
      constraints: [],
      facts,
    };
  }

  const executionRatio = last.actualLoad / last.plannedLoad;
  facts.lastWeekPlanned = Math.round(last.plannedLoad);
  facts.lastWeekActual = Math.round(last.actualLoad);
  facts.executionRatio = Math.round(executionRatio * 100) / 100;

  // ---- Persistent undershoot: bring the PLAN down, never chase it --------
  const shortfalls = recent.filter(
    (w) => w.plannedLoad > 0 && w.actualLoad / w.plannedLoad < 1 - PLAN_DOWNGRADE_SHORTFALL
  );
  if (
    shortfalls.length >= PLAN_DOWNGRADE_WEEKS &&
    recent.slice(-PLAN_DOWNGRADE_WEEKS).every(
      (w) => w.plannedLoad > 0 && w.actualLoad / w.plannedLoad < 1 - PLAN_DOWNGRADE_SHORTFALL
    )
  ) {
    const achieved =
      recent.slice(-PLAN_DOWNGRADE_WEEKS).reduce((n, w) => n + w.actualLoad, 0) /
      PLAN_DOWNGRADE_WEEKS;
    // Land just above what is actually being achieved, not at the old target.
    const target = Math.min(nextWeekPlanned, achieved * 1.05);
    return {
      targetLoad: Math.round(target),
      factor: round2(target / nextWeekPlanned),
      action: "downgrade_plan",
      reason:
        `Training has come in more than ${Math.round(PLAN_DOWNGRADE_SHORTFALL * 100)}% ` +
        `below plan for ${PLAN_DOWNGRADE_WEEKS} weeks running. The plan is being ` +
        `brought down to what you are actually sustaining, rather than asking you ` +
        `to catch up.`,
      constraints: [capWeek(nextWeekStart, weekEnd, target, "macro_planner", "hard")],
      facts: { ...facts, downgradedTo: Math.round(target) },
    };
  }

  // ---- Overshoot: tighten, and pull recovery forward if the ramp broke ---
  const ramp = rampOf(
    recent.length >= 2 ? recent[recent.length - 2].actualLoad : last.plannedLoad,
    last.actualLoad
  );
  facts.rampPct = Math.round(ramp * 100);

  const overloadWeeks = state.consecutiveOverloadWeeks ?? 0;
  const rampBreached = ramp * 100 > RAMP_LIMIT_OVERLOAD;
  const overReached = executionRatio > 1.3;

  if (rampBreached || overloadWeeks >= MAX_CONSECUTIVE_OVERLOAD) {
    const target = last.actualLoad * RECOVERY_WEEK_FACTOR;
    return {
      targetLoad: Math.round(target),
      factor: round2(target / nextWeekPlanned),
      action: "recovery_week",
      reason:
        rampBreached
          ? `Load rose ${Math.round(ramp * 100)}% week on week, past the ` +
            `${RAMP_LIMIT_OVERLOAD}% ceiling, so the recovery week is being pulled ` +
            `forward rather than risking the ramp.`
          : `Two consecutive overload weeks have been taken, so the next week ` +
            `becomes a recovery week.`,
      constraints: [capWeek(nextWeekStart, weekEnd, target, "macro_planner", "hard")],
      facts: { ...facts, forcedRecovery: true },
    };
  }

  if (overReached) {
    // Give back the excess, but only down to the planned week — never below,
    // and never by inflating anything later.
    const excess = last.actualLoad - last.plannedLoad;
    const target = Math.max(nextWeekPlanned * 0.85, nextWeekPlanned - excess * 0.5);
    return {
      targetLoad: Math.round(target),
      factor: round2(target / nextWeekPlanned),
      action: "tighten",
      reason:
        `Last week finished ${Math.round((executionRatio - 1) * 100)}% above plan, ` +
        `so the coming week is held below target to absorb it.`,
      constraints: [capWeek(nextWeekStart, weekEnd, target, "macro_planner", "hard")],
      facts: { ...facts, tightenedTo: Math.round(target) },
    };
  }

  // ---- Undershoot within tolerance: forgive it, change nothing ----------
  return {
    targetLoad: nextWeekPlanned,
    factor: 1,
    action: "hold",
    reason:
      executionRatio < 1
        ? "Last week came in under plan. Load debt is forgiven — the coming week stands as written."
        : "Last week tracked the plan. No change needed.",
    constraints: [],
    facts,
  };
}

function capWeek(
  fromDate: string,
  toDate: string,
  target: number,
  source: string,
  type: "hard" | "soft"
): Constraint {
  return {
    kind: "cap_load",
    type,
    source,
    reason: `The week of ${fromDate} is capped at ${Math.round(target)} load.`,
    fromDate,
    toDate,
    limit: Math.round(target),
    weight: 4,
  };
}

function addDaysISO(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Anchor selection (v3 spec 3.2): 2–3 key sessions per week that must survive
 * every daily adaptation.
 *
 * Without a race-course limiter analysis we cannot rank disciplines by time
 * lost, so this uses an explainable proxy: the highest-load session in each
 * discipline, capped at three per week, ignoring rest. Documented as a
 * heuristic so it is not mistaken for the spec's ROI ranking.
 */
export function selectAnchors<T extends { id: string; discipline: string; tss: number }>(
  weekSessions: T[],
  max = 3,
  /**
   * ROI per discipline from the limiter analysis (v3 §3.1). When present,
   * anchors are weighted towards the disciplines where race time is actually
   * won, rather than simply the hardest session of each.
   */
  priority?: Record<string, number>
): string[] {
  const byDiscipline = new Map<string, T>();
  for (const s of weekSessions) {
    const key = s.discipline.toLowerCase();
    if (key.includes("rest")) continue;
    const current = byDiscipline.get(key);
    if (!current || s.tss > current.tss) byDiscipline.set(key, s);
  }

  const weightOf = (s: T) => {
    if (!priority) return s.tss;
    const key = Object.keys(priority).find((k) =>
      s.discipline.toLowerCase().includes(k)
    );
    // ROI is a 0..1 share; scale it so it meaningfully reorders equal sessions
    // without letting a trivial session outrank a genuinely hard one.
    const roi = key ? priority[key] : 0;
    return s.tss * (1 + roi);
  };

  return [...byDiscipline.values()]
    .sort((a, b) => weightOf(b) - weightOf(a) || a.id.localeCompare(b.id))
    .slice(0, max)
    .map((s) => s.id);
}

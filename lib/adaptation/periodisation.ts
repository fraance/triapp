/**
 * Periodisation: the weekly load budget, computed rather than requested.
 *
 * The plan that had to be regenerated asked an LLM for "target hours, grounded
 * in demonstrated volume, no more than ~10% jumps" — and then trusted the
 * answer. It came back with a week 70% above what the athlete had actually
 * been doing, which no amount of downstream adaptation could rescue: every
 * session the solver touched still left the week outside the ramp guardrail.
 *
 * So the numbers are worked out here, deterministically, from what the athlete
 * has really been training. The LLM is left to do what it is good at — writing
 * the sessions — inside a budget it cannot argue with.
 *
 * Rules applied (v3 §3.3, LOGIC_V2 §2.1-2.2):
 *   - ramp ≤ 8% week on week, and never from an invented starting point
 *   - 3:1 load/recovery cycles, recovery weeks at 60%
 *   - a real taper, and a race week that is mostly rest
 */

export type Phase = "Base" | "Build" | "Peak" | "Taper" | "Race" | "Recovery";

export interface WeekBudget {
  week: number;
  phase: Phase;
  /** Total load the week may not exceed. */
  targetLoad: number;
  /** Roughly what that is in hours, for the athlete-facing plan. */
  targetHours: number;
  isRecovery: boolean;
  isRaceWeek: boolean;
  focus: string;
}

export interface PeriodisationInput {
  /** Weeks including race week. */
  totalWeeks: number;
  /**
   * What the athlete has actually been doing per week, as total load.
   * This is the anchor for everything: a plan that starts above it is a plan
   * that starts with a guardrail breach.
   */
  recentWeeklyLoad: number;
  /** Their biggest genuine week, so a conservative average is not a cage. */
  peakWeeklyLoad?: number | null;
  /** Weekly ramp ceiling as a fraction. */
  rampRate?: number;
  /** Hours per unit of load, from their own history. */
  hoursPerLoad?: number | null;
  /** Cap from declared availability, if they gave one. */
  maxWeeklyHours?: number | null;
}

export const DEFAULT_RAMP = 0.08;
export const RECOVERY_FACTOR = 0.6;
/** Load : recovery. Three build weeks then a lighter one. */
export const CYCLE_LENGTH = 4;

/**
 * A sane starting point when the athlete has almost no history — deliberately
 * low. Starting too low costs a fortnight; starting too high costs a season.
 */
const COLD_START_LOAD = 150;

export function buildWeeklyBudgets(input: PeriodisationInput): WeekBudget[] {
  const {
    totalWeeks,
    recentWeeklyLoad,
    peakWeeklyLoad,
    rampRate = DEFAULT_RAMP,
    hoursPerLoad,
    maxWeeklyHours,
  } = input;

  if (totalWeeks <= 0) return [];

  // Start from what they are actually sustaining. Their best recent week is
  // evidence they can hold more than the average, so allow a little of it —
  // but never let a single big week become the new baseline.
  const base =
    recentWeeklyLoad > 0
      ? Math.min(
          // A genuine big week is evidence they can hold more than the
          // average, so allow a little of it...
          peakWeeklyLoad && peakWeeklyLoad > recentWeeklyLoad
            ? recentWeeklyLoad + (peakWeeklyLoad - recentWeeklyLoad) * 0.25
            : recentWeeklyLoad,
          // ...but never past the ramp. Week 1 breaching the same guardrail
          // that governs every later week is how the previous plan became
          // unadaptable from the day it was written.
          recentWeeklyLoad * (1 + rampRate)
        )
      : COLD_START_LOAD;

  // How the last weeks are shaped, regardless of how long the plan is.
  const raceWeek = totalWeeks;
  const taperWeeks = totalWeeks >= 8 ? 2 : totalWeeks >= 4 ? 1 : 0;

  const budgets: WeekBudget[] = [];
  let current = base;

  for (let week = 1; week <= totalWeeks; week++) {
    const weeksToRace = raceWeek - week;
    const isRaceWeek = week === raceWeek;
    const isTaper = !isRaceWeek && weeksToRace < taperWeeks + 1 && taperWeeks > 0;
    // Every CYCLE_LENGTH-th week comes down, so fatigue can clear.
    const isRecovery = !isRaceWeek && !isTaper && week % CYCLE_LENGTH === 0;

    let target: number;
    let phase: Phase;
    let focus: string;

    if (isRaceWeek) {
      target = base * 0.35;
      phase = "Race";
      focus = "Race week: short, sharp, mostly rest. Arrive fresh.";
    } else if (isTaper) {
      // Two-week taper: 70% then 55% of the last build week.
      const depth = weeksToRace === 1 ? 0.55 : 0.7;
      target = current * depth;
      phase = "Taper";
      focus = "Volume down, a little intensity kept in to stay sharp.";
    } else if (isRecovery) {
      target = current * RECOVERY_FACTOR;
      phase = "Recovery";
      focus = "Deliberate deload — this is where the previous three weeks land.";
    } else {
      // Build on the last *loading* week, not on a recovery week.
      const lastLoading = budgets
        .slice()
        .reverse()
        .find((b) => !b.isRecovery && !b.isRaceWeek && b.phase !== "Taper");
      const from = lastLoading ? lastLoading.targetLoad : base;
      target = week === 1 ? base : from * (1 + rampRate);

      // Progress through the *loading* part of the plan, not the whole thing.
      // Measured against totalWeeks the taper swallowed the Peak phase, so a
      // 12-week plan never reached one.
      const lastLoadingWeek = Math.max(1, totalWeeks - taperWeeks - 1);
      const progress = week / lastLoadingWeek;
      phase = progress < 0.45 ? "Base" : progress < 0.8 ? "Build" : "Peak";
      focus =
        phase === "Base"
          ? "Aerobic foundation and technique."
          : phase === "Build"
            ? "Race-specific intensity on top of the base."
            : "Sharpening: race-pace work, lower volume.";
      current = target;
    }

    // Availability is a hard ceiling: a budget the athlete has no time for is
    // a plan they will fail out of.
    let hours = hoursPerLoad ? target * hoursPerLoad : target / 55;
    if (maxWeeklyHours && hours > maxWeeklyHours) {
      hours = maxWeeklyHours;
      target = hoursPerLoad ? hours / hoursPerLoad : hours * 55;
    }

    budgets.push({
      week,
      phase,
      targetLoad: Math.round(target),
      targetHours: Math.round(hours * 10) / 10,
      isRecovery,
      isRaceWeek,
      focus,
    });
  }

  return budgets;
}

/**
 * Checks a set of weekly totals against the budgets.
 * Used after generation: the model is asked to hit the targets, and this is
 * what verifies it actually did rather than assuming.
 */
export function weeksOverBudget(
  budgets: WeekBudget[],
  actualByWeek: Record<number, number>,
  tolerance = 0.05
): Array<{ week: number; target: number; actual: number; overBy: number }> {
  const out: Array<{ week: number; target: number; actual: number; overBy: number }> = [];
  for (const b of budgets) {
    const actual = actualByWeek[b.week] ?? 0;
    if (actual > b.targetLoad * (1 + tolerance)) {
      out.push({
        week: b.week,
        target: b.targetLoad,
        actual: Math.round(actual),
        overBy: Math.round(actual - b.targetLoad),
      });
    }
  }
  return out;
}

/**
 * Scales a week's sessions so the total lands inside its budget.
 *
 * Proportional rather than clever: it preserves the shape the coach wrote
 * (which session is the hard one, which is easy) while bringing the magnitude
 * back to something the athlete can absorb. Rest days stay at zero.
 */
export function conformWeek<T extends { tss: number }>(
  sessions: T[],
  targetLoad: number
): T[] {
  const total = sessions.reduce((n, s) => n + (s.tss || 0), 0);
  if (total <= targetLoad || total === 0) return sessions;
  const factor = targetLoad / total;
  return sessions.map((s) => ({ ...s, tss: Math.round((s.tss || 0) * factor) }));
}

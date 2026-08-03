/**
 * Guardrail layer (spec Part 5) — inviolable.
 *
 * This sits ABOVE the solver. No learned weight, athlete preference or manual
 * drag can breach it. If a candidate plan violates a guardrail, the solver
 * discards that candidate outright; it is not a penalty to be outweighed.
 *
 * Every limit here exists to prevent injury or illness, which is the one thing
 * an adaptive plan can get catastrophically wrong. When in doubt these are
 * deliberately conservative.
 */
import {
  LoadVector,
  LOAD_COMPONENTS,
  SolverSession,
  ZERO_LOAD,
} from "./types";
import { acwr, addLoad, localISO, scaleLoad as scaleVector, sumLoad, totalLoad } from "./load-vector";

export interface GuardrailLimits {
  /** Max week-on-week increase in total load. */
  maxWeeklyRamp: number;
  /** Mechanical impact ramps more slowly — it is what breaks people. */
  maxMechanicalRamp: number;
  /** Acute:chronic ratio must stay inside this band. */
  acwrMin: number;
  acwrMax: number;
  /** Above this, training is blocked outright. */
  acwrBlock: number;
  /** Minimum hours between two sessions on the same day (unless a brick). */
  minSameDaySeparationHours: number;
  /** Hours that must separate two key sessions loading the same component. */
  minKeySessionSeparationHours: number;
}

export const DEFAULT_LIMITS: GuardrailLimits = {
  maxWeeklyRamp: 0.08,
  maxMechanicalRamp: 0.05,
  acwrMin: 0.8,
  acwrMax: 1.3,
  acwrBlock: 1.5,
  minSameDaySeparationHours: 6,
  minKeySessionSeparationHours: 48,
};

export interface GuardrailViolation {
  rule: string;
  /** Human-readable, shown to the athlete when a plan is blocked. */
  detail: string;
  /** "block" stops the candidate outright. */
  severity: "block";
}

/** A session counts as "key" if it is an anchor or genuinely hard. */
export function isKeySession(s: SolverSession): boolean {
  if (s.isAnchor) return true;
  return s.load.neuromuscular >= 25 || totalLoad(s.load) >= 70;
}

/** Which component a session predominantly loads. */
export function dominantComponent(load: LoadVector): keyof LoadVector {
  let best: keyof LoadVector = "metabolic";
  for (const k of LOAD_COMPONENTS) if (load[k] > load[best]) best = k;
  return best;
}

function hoursBetween(aISO: string, bISO: string): number {
  const a = new Date(aISO + "T00:00:00").getTime();
  const b = new Date(bISO + "T00:00:00").getTime();
  return Math.abs(b - a) / (60 * 60 * 1000);
}

/** Groups sessions by ISO date. */
function byDate(sessions: SolverSession[]): Map<string, SolverSession[]> {
  const m = new Map<string, SolverSession[]>();
  for (const s of sessions) {
    if (s.dropped) continue;
    const list = m.get(s.date) ?? [];
    list.push(s);
    m.set(s.date, list);
  }
  return m;
}

/** Sums load over rolling 7-day windows starting at each session date. */
function weeklyLoads(sessions: SolverSession[]): Map<string, LoadVector> {
  const dates = [...new Set(sessions.filter((s) => !s.dropped).map((s) => s.date))].sort();
  const out = new Map<string, LoadVector>();
  for (const start of dates) {
    const end = new Date(start + "T00:00:00");
    end.setDate(end.getDate() + 6);
    // localISO, not toISOString: converting a local midnight to UTC rolls it
    // back a day, so the "7-day" ramp window was only covering six.
    const endISO = localISO(end);
    const inWindow = sessions.filter(
      (s) => !s.dropped && s.date >= start && s.date <= endISO
    );
    out.set(start, sumLoad(inWindow.map((s) => s.load)));
  }
  return out;
}

export interface GuardrailContext {
  /** Rolling chronic load (42-day EWMA), per component. */
  chronicLoad: LoadVector;
  /** Load actually completed in the previous 7 days. */
  previousWeekLoad: LoadVector;
  limits?: GuardrailLimits;
  /** Athlete is ill / medically suspended — blocks all training. */
  suspended?: boolean;
  /**
   * Days of reliable chronic-load history (v3 §5, the Cold Start Trap).
   * With fewer than 28, the 28-day denominator is artificially low, ACWR
   * spikes, and the engine would zero out the athlete's week. Below the
   * threshold ACWR is ignored entirely and a daily ceiling governs instead.
   */
  chronicHistoryDays?: number;
  /** Daily load ceiling used while chronic history is too short. */
  dailyLoadCeiling?: number;
  /** Dates a long session is allowed to occupy (v3 §4.3). */
  longSessionDates?: string[];
}

/** v3 §5: ACWR needs a trustworthy 28-day denominator. */
export const MIN_CHRONIC_HISTORY_DAYS = 28;

/**
 * Checks a candidate plan. Returns every violation found (not just the first),
 * so the log can explain exactly why a candidate was rejected.
 *
 * Pure function: no database, no clock, no randomness.
 */
export function checkGuardrails(
  sessions: SolverSession[],
  ctx: GuardrailContext
): GuardrailViolation[] {
  const limits = ctx.limits ?? DEFAULT_LIMITS;
  const violations: GuardrailViolation[] = [];
  const active = sessions.filter((s) => !s.dropped);

  // ---- Illness suspension ------------------------------------------------
  if (ctx.suspended && active.some((s) => totalLoad(s.load) > 0)) {
    violations.push({
      rule: "illness_suspension",
      detail: "Training is suspended on medical grounds; no load may be scheduled.",
      severity: "block",
    });
  }

  // ---- Weekly ramp rate --------------------------------------------------
  const prevTotal = totalLoad(ctx.previousWeekLoad);
  if (prevTotal > 0) {
    for (const [start, load] of weeklyLoads(active)) {
      const total = totalLoad(load);
      const rampCap = prevTotal * (1 + limits.maxWeeklyRamp);
      if (total > rampCap * 1.001) {
        violations.push({
          rule: "weekly_ramp",
          detail:
            `Week beginning ${start} totals ${Math.round(total)} load vs ` +
            `${Math.round(prevTotal)} last week — above the ` +
            `+${Math.round(limits.maxWeeklyRamp * 100)}% ceiling.`,
          severity: "block",
        });
        break; // one ramp violation is enough to reject the candidate
      }
      const mechCap =
        ctx.previousWeekLoad.mechanical * (1 + limits.maxMechanicalRamp);
      if (ctx.previousWeekLoad.mechanical > 0 && load.mechanical > mechCap * 1.001) {
        violations.push({
          rule: "mechanical_ramp",
          detail:
            `Impact load in the week beginning ${start} rises more than ` +
            `+${Math.round(limits.maxMechanicalRamp * 100)}%, which is how ` +
            `running injuries happen.`,
          severity: "block",
        });
        break;
      }
    }
  }

  // ---- Acute:chronic workload ratio -------------------------------------
  // chronicLoad is an EWMA **per day**, so the acute side must also be per
  // day. Comparing a multi-day sum against a daily average inflates the ratio
  // several times over and blocks perfectly reasonable weeks.
  const historyDays = ctx.chronicHistoryDays ?? MIN_CHRONIC_HISTORY_DAYS;
  const acwrTrustworthy = historyDays >= MIN_CHRONIC_HISTORY_DAYS;

  if (!acwrTrustworthy) {
    // Cold start: govern by a daily ceiling instead of a ratio built on a
    // denominator we do not have.
    const ceiling = ctx.dailyLoadCeiling;
    if (ceiling && ceiling > 0) {
      for (const [date, list] of byDate(active)) {
        const dayTotal = list.reduce((n, s) => n + totalLoad(s.load), 0);
        if (dayTotal > ceiling + 0.5) {
          violations.push({
            rule: "daily_ceiling",
            detail:
              `${date} totals ${Math.round(dayTotal)} load, above the ` +
              `${Math.round(ceiling)} daily ceiling used while there is less ` +
              `than ${MIN_CHRONIC_HISTORY_DAYS} days of history.`,
            severity: "block",
          });
        }
      }
    }
  } else if (totalLoad(ctx.chronicLoad) > 0 && active.length > 0) {
    const dates = active.map((s) => s.date).sort();
    const windowStart = new Date(dates[0] + "T00:00:00");
    const windowEnd = new Date(windowStart);
    windowEnd.setDate(windowEnd.getDate() + 6);
    const endISO = localISO(windowEnd);

    const inWindow = active.filter((s) => s.date >= dates[0] && s.date <= endISO);
    const acuteDaily = scaleVector(sumLoad(inWindow.map((s) => s.load)), 1 / 7);
    const ratios = acwr(acuteDaily, ctx.chronicLoad);

    for (const k of LOAD_COMPONENTS) {
      if (ctx.chronicLoad[k] <= 0) continue;
      if (ratios[k] > limits.acwrBlock) {
        violations.push({
          rule: "acwr_block",
          detail:
            `${k} acute:chronic ratio would reach ${ratios[k].toFixed(2)} ` +
            `(blocked above ${limits.acwrBlock}) — that is the injury red zone.`,
          severity: "block",
        });
      }
    }
  }

  // ---- Same-day separation ----------------------------------------------
  for (const [date, list] of byDate(active)) {
    const real = list.filter((s) => totalLoad(s.load) > 0);
    if (real.length < 2) continue;
    const isBrick = real.some((s) => /brick/i.test(s.discipline));
    if (isBrick) continue;
    // We schedule by day, not clock time, so two hard sessions sharing a day
    // cannot be guaranteed the required gap.
    const hard = real.filter(isKeySession);
    if (hard.length > 1) {
      violations.push({
        rule: "same_day_separation",
        detail:
          `${date} has ${hard.length} key sessions; they need at least ` +
          `${limits.minSameDaySeparationHours}h apart, which a single day cannot guarantee.`,
        severity: "block",
      });
    }
  }

  // ---- Key sessions loading the same component too close together --------
  const keys = active
    .filter(isKeySession)
    .sort((a, b) => a.date.localeCompare(b.date));
  for (let i = 1; i < keys.length; i++) {
    const prev = keys[i - 1];
    const cur = keys[i];
    if (dominantComponent(prev.load) !== dominantComponent(cur.load)) continue;
    const gap = hoursBetween(prev.date, cur.date);
    if (gap < limits.minKeySessionSeparationHours) {
      violations.push({
        rule: "key_session_separation",
        detail:
          `Two key ${dominantComponent(cur.load)} sessions on ${prev.date} and ` +
          `${cur.date} are only ${Math.round(gap)}h apart ` +
          `(minimum ${limits.minKeySessionSeparationHours}h).`,
        severity: "block",
      });
    }
  }

  // ---- Heavy run must not immediately precede a heavy bike ---------------
  const sorted = [...active].sort((a, b) => a.date.localeCompare(b.date));
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (hoursBetween(prev.date, cur.date) > 24) continue;
    const prevRun = /run/i.test(prev.discipline) && isKeySession(prev);
    const curBike = /bike|ride|cycl/i.test(cur.discipline) && isKeySession(cur);
    if (prevRun && curBike) {
      violations.push({
        rule: "run_before_bike",
        detail:
          `A hard run on ${prev.date} directly before a hard bike on ${cur.date} ` +
          `leaves the legs unable to produce the bike session's purpose.`,
        severity: "block",
      });
    }
  }

  // ---- Long sessions stay where real life allows (v3 §4.3) --------------
  // "Do not shift weekend volume to weekday mornings; trim weekday volume
  // first." A long session that has been moved off an allowed day is a hard
  // failure, not a penalty to be traded away.
  for (const s of active) {
    if (!s.isLong) continue;
    // A session the athlete cannot physically do had to move; the solver only
    // relocates a long session when it is impossible where it stood.
    if (s.movedBecauseImpossible) continue;
    if (s.movedFrom && s.movedFrom !== s.date) {
      violations.push({
        rule: "long_session_moved",
        detail:
          `${s.discipline} on ${s.date} is a long session and is pinned to the ` +
          `days you can actually accommodate it.`,
        severity: "block",
      });
      continue;
    }
    const allowed = ctx.longSessionDates;
    if (allowed && allowed.length > 0 && !allowed.includes(s.date)) {
      violations.push({
        rule: "long_session_day",
        detail:
          `${s.discipline} on ${s.date} is a long session but that is not a day ` +
          `you have time for one.`,
        severity: "block",
      });
    }
  }

  // ---- Anchors must survive ---------------------------------------------
  for (const s of sessions) {
    // An anchor the athlete cannot physically perform is not being sacrificed
    // to optimisation; it simply cannot happen.
    if (s.droppedBecauseImpossible) continue;
    if (s.isAnchor && s.dropped) {
      violations.push({
        rule: "anchor_dropped",
        detail: `${s.discipline} on ${s.date} is a key session and cannot be dropped.`,
        severity: "block",
      });
    }
  }

  return violations;
}

/** Convenience: does this candidate pass every guardrail? */
export function passesGuardrails(
  sessions: SolverSession[],
  ctx: GuardrailContext
): boolean {
  return checkGuardrails(sessions, ctx).length === 0;
}

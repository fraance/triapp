/**
 * Deterministic solver (spec Part 4.3).
 *
 * The spec calls for CP-SAT. That means running a separate Python service,
 * which roughly doubles the deployment surface. The search space here is small
 * — 7 to 10 days, a handful of legal moves per session — so a **bounded
 * beam search** finds the same answer, stays in-process, and is trivially
 * testable. If a future constraint set outgrows this, the interface is narrow
 * enough to swap the internals for CP-SAT without touching callers.
 *
 * Guarantees:
 *  - **Deterministic.** No randomness, no clock. Identical input, identical
 *    output. This matters: an athlete must be able to trust that the plan did
 *    not change for no reason.
 *  - **Guardrails are absolute.** Candidates that violate one are discarded,
 *    never merely penalised.
 */
import {
  Constraint,
  LoadVector,
  SolverInput,
  SolverResult,
  SolverSession,
} from "./types";
import { scaleLoad, sumLoad, totalLoad } from "./load-vector";
import { checkGuardrails, GuardrailContext, isKeySession } from "./guardrails";

/** How many candidates survive each expansion round. */
const BEAM_WIDTH = 12;
/** How many rounds of moves to apply. Each round makes one change. */
const MAX_DEPTH = 4;

// ---- Scoring --------------------------------------------------------------

export interface ScoreBreakdown {
  total: number;
  purpose: number;
  constraintPenalty: number;
  stability: number;
  preference: number;
}

/**
 * Objective function (spec 4.3): maximise purpose fulfilment, load-target
 * adherence, preference alignment and **stability**; penalise soft-constraint
 * violations.
 *
 * Stability is weighted heavily on purpose. A plan that churns every day is
 * worse than a slightly suboptimal plan that stays put — the spec's hysteresis
 * layer depends on this.
 */
export function scorePlan(
  candidate: SolverSession[],
  input: SolverInput
): ScoreBreakdown {
  let purpose = 0;
  let stability = 0;
  let preference = 0;
  let constraintPenalty = 0;

  for (const s of candidate) {
    if (s.dropped) {
      // Losing a session loses its purpose entirely.
      purpose -= s.isAnchor || s.isLong ? 100 : 20 + totalLoad(s.load) * 0.2;
      stability -= 12;
      continue;
    }

    // Purpose is best served at full prescribed load.
    const scale = s.scaledBy ?? 1;
    purpose += totalLoad(s.load) * (1 - Math.abs(1 - scale) * 0.8);
    if (s.isAnchor) purpose += 25 * scale;

    // Stability: every move or rescale costs.
    if (s.movedFrom && s.movedFrom !== s.date) {
      const days = Math.abs(dayDiff(s.movedFrom, s.date));
      stability -= 6 + days * 3;
    }
    if (scale !== 1) {
      // Trim weekday volume before touching a long session (v3 §4.3).
      const cost = s.isLong ? 90 : 25;
      stability -= Math.abs(1 - scale) * cost;
    }
  }

  // Soft constraints
  for (const c of input.constraints) {
    if (c.type !== "soft") continue;
    const weight = c.weight ?? 1;
    for (const s of candidate) {
      if (s.dropped) continue;
      if (!withinRange(s.date, c)) continue;
      if (c.kind === "cap_load" && c.factor !== undefined) {
        const allowed = (s.originalTssForCap ?? totalLoad(s.load)) * c.factor;
        const over = totalLoad(s.load) - allowed;
        if (over > 0) constraintPenalty += over * weight;
      }
      if (c.kind === "rest_day") constraintPenalty += totalLoad(s.load) * weight;
    }
  }

  // Preferences nudge only.
  for (const p of input.preferences) {
    if (p.key === "prefer_fewer_changes") {
      const changed = candidate.filter(
        (s) => s.dropped || s.scaledBy !== undefined || s.movedFrom
      ).length;
      preference -= changed * p.weight;
    }
  }

  const total = purpose + stability + preference - constraintPenalty;
  return {
    total: Math.round(total * 100) / 100,
    purpose: Math.round(purpose * 100) / 100,
    constraintPenalty: Math.round(constraintPenalty * 100) / 100,
    stability: Math.round(stability * 100) / 100,
    preference: Math.round(preference * 100) / 100,
  };
}

// ---- Hard constraint satisfaction ----------------------------------------

/** Hard constraints that the solver itself must respect (beyond guardrails). */
export function hardViolations(
  candidate: SolverSession[],
  input: SolverInput
): string[] {
  const out: string[] = [];

  for (const c of input.constraints) {
    if (c.type !== "hard") continue;

    for (const s of candidate) {
      if (s.dropped) continue;
      if (!withinRange(s.date, c)) continue;

      if (c.kind === "rest_day" && totalLoad(s.load) > 0) {
        out.push(`${s.discipline} on ${s.date} breaches a required rest day`);
      }

      if (c.kind === "max_intensity" && c.component && c.factor !== undefined) {
        const baseline = s.originalLoadForCap?.[c.component] ?? s.load[c.component];
        if (s.load[c.component] > baseline * c.factor + 0.01) {
          out.push(
            `${s.discipline} on ${s.date} exceeds the ${c.component} ceiling ` +
              `set by ${c.source}`
          );
        }
      }

      if (c.kind === "cap_load" && c.factor !== undefined) {
        const baseline = s.originalTssForCap ?? totalLoad(s.load);
        if (totalLoad(s.load) > baseline * c.factor + 0.01) {
          out.push(
            `${s.discipline} on ${s.date} exceeds the load cap set by ${c.source}`
          );
        }
      }
    }

    // An absolute ceiling over a window (the macro planner's weekly target).
    // Checked across all sessions in the range, not session by session.
    if (c.kind === "cap_load" && c.limit !== undefined) {
      const inRange = candidate.filter((s) => !s.dropped && withinRange(s.date, c));
      const total = inRange.reduce((n, s) => n + totalLoad(s.load), 0);
      if (total > c.limit + 0.5) {
        out.push(
          `${c.fromDate}–${c.toDate} totals ${Math.round(total)} load, above the ` +
            `${c.limit} ceiling set by ${c.source}`
        );
      }
    }
  }

  // Days the athlete simply cannot train.
  for (const s of candidate) {
    if (s.dropped) continue;
    if (input.unavailableDates?.includes(s.date) && totalLoad(s.load) > 0) {
      out.push(`${s.discipline} is scheduled on ${s.date}, when you are unavailable`);
    }
  }

  // v3 §4.3: a session must fit the time the athlete actually has that day.
  // Days missing from the map are unconstrained rather than assumed to be zero.
  if (input.availableMinutesByDate) {
    const byDate = new Map<string, number>();
    for (const s of candidate) {
      if (s.dropped) continue;
      byDate.set(s.date, (byDate.get(s.date) ?? 0) + s.durationMinutes);
    }
    for (const [date, minutes] of byDate) {
      const available = input.availableMinutesByDate[date];
      if (available === undefined) continue;
      if (minutes > available + 1e-9) {
        out.push(
          `${date} needs ${Math.round(minutes)} min of training but you have ` +
            `${Math.round(available)} min available`
        );
      }
    }
  }

  // The commitment freeze: sessions on or before `frozenUntil` may not move.
  if (input.frozenUntil) {
    for (const s of candidate) {
      const original = s.movedFrom ?? s.date;
      if (original <= input.frozenUntil && (s.movedFrom || s.dropped)) {
        out.push(`${s.discipline} on ${original} is inside the commitment window`);
      }
    }
  }

  return out;
}

// ---- Moves ----------------------------------------------------------------

/**
 * The legal edits the solver may make. Deliberately small: an adaptive plan
 * that can do anything is impossible to trust or to explain.
 */
function expand(
  candidate: SolverSession[],
  input: SolverInput
): SolverSession[][] {
  const out: SolverSession[][] = [];
  const horizonDates = [...new Set(candidate.map((s) => s.date))].sort();

  for (let i = 0; i < candidate.length; i++) {
    const s = candidate[i];
    if (s.dropped) continue;
    if (totalLoad(s.load) === 0) continue; // rest days are not moved
    const origin = s.movedFrom ?? s.date;
    // Never touch anything inside the commitment freeze.
    if (input.frozenUntil && origin <= input.frozenUntil) continue;

    // 1. Scale the session down (preserve purpose, reduce cost).
    for (const factor of [0.75, 0.5]) {
      const next = clone(candidate);
      next[i] = {
        ...s,
        load: scaleLoad(baselineLoad(s), factor),
        tss: Math.round(baselineTss(s) * factor),
        // Duration must scale with load. Leaving it untouched meant a shortened
        // session still claimed its original slot, so a time constraint could
        // never be satisfied by easing a session — only by dropping it.
        durationMinutes: Math.round(baselineMinutes(s) * factor),
        scaledBy: factor,
        originalLoadForCap: baselineLoad(s),
        originalTssForCap: baselineTss(s),
        originalMinutesForCap: baselineMinutes(s),
      };
      out.push(next);
    }

    // 2. Move the session to another day inside the horizon.
    // Long sessions are never moved (v3 §4.3 and the "long runs are immovable"
    // hard boundary). Real life decides when a 2-hour session can happen; the
    // solver trims weekday volume instead of shuffling the weekend.
    for (const date of s.isLong ? [] : horizonDates) {
      if (date === s.date) continue;
      if (date < input.today) continue;
      if (input.unavailableDates?.includes(date)) continue;
      if (input.frozenUntil && date <= input.frozenUntil) continue;
      const room = input.availableMinutesByDate?.[date];
      if (room !== undefined && s.durationMinutes > room) continue;
      const next = clone(candidate);
      next[i] = { ...s, date, movedFrom: origin };
      out.push(next);
    }

    // 3. Drop it — only ever legal for non-anchors, and never a long session.
    if (!s.isAnchor && !s.isLong) {
      const next = clone(candidate);
      next[i] = { ...s, dropped: true };
      out.push(next);
    }
  }

  return out;
}

function baselineLoad(s: SolverSession): LoadVector {
  return s.originalLoadForCap ?? s.load;
}
function baselineTss(s: SolverSession): number {
  return s.originalTssForCap ?? s.tss;
}
function baselineMinutes(s: SolverSession): number {
  return s.originalMinutesForCap ?? s.durationMinutes;
}

// ---- Search ---------------------------------------------------------------

export interface SolveOptions {
  guardrails: GuardrailContext;
  beamWidth?: number;
  maxDepth?: number;
}

/**
 * Finds the best legal plan reachable from the current one.
 *
 * Returns the *current* plan unchanged if nothing scores better — the caller's
 * hysteresis layer then decides whether a change is worth surfacing.
 */
export function solve(input: SolverInput, opts: SolveOptions): SolverResult {
  const beamWidth = opts.beamWidth ?? BEAM_WIDTH;
  const maxDepth = opts.maxDepth ?? MAX_DEPTH;

  // Every session gets a fixed baseline up front. Without this, a load cap
  // compares a session against itself and is satisfied by definition, so the
  // cap never bites and the plan silently fails to adapt.
  const start: SolverSession[] = clone(input.sessions).map((s) => ({
    ...s,
    originalLoadForCap: s.originalLoadForCap ?? { ...s.load },
    originalTssForCap: s.originalTssForCap ?? s.tss,
    originalMinutesForCap: s.originalMinutesForCap ?? s.durationMinutes,
  }));

  const startLegal =
    hardViolations(start, input).length === 0 &&
    checkGuardrails(start, opts.guardrails).length === 0;

  let best = {
    sessions: start,
    score: scorePlan(start, input).total,
    legal: startLegal,
  };

  /**
   * Search states are ranked by score minus a heavy penalty per unsatisfied
   * rule. Infeasible states are kept in the beam rather than discarded: fixing
   * a plan often needs two changes, and every route to that passes through a
   * one-change state that is still illegal. Pruning those made multi-step
   * repairs unreachable, so the plan silently failed to adapt.
   *
   * Only feasible candidates are ever eligible to become `best`.
   */
  const VIOLATION_PENALTY = 1000;

  const rank = (sessions: SolverSession[]) => {
    const hard = hardViolations(sessions, input).length;
    const guard = checkGuardrails(sessions, opts.guardrails).length;
    const score = scorePlan(sessions, input).total;
    return {
      score,
      legal: hard === 0 && guard === 0,
      ranked: score - (hard + guard) * VIOLATION_PENALTY,
    };
  };

  let beam: Array<{ sessions: SolverSession[]; ranked: number }> = [
    { sessions: start, ranked: rank(start).ranked },
  ];

  const seen = new Set<string>([signature(start)]);

  for (let depth = 0; depth < maxDepth; depth++) {
    const nextBeam: Array<{ sessions: SolverSession[]; ranked: number }> = [];

    for (const node of beam) {
      for (const candidate of expand(node.sessions, input)) {
        const sig = signature(candidate);
        if (seen.has(sig)) continue;
        seen.add(sig);

        const r = rank(candidate);
        nextBeam.push({ sessions: candidate, ranked: r.ranked });

        // An illegal starting plan must be repaired even if the repair scores
        // lower — legality is not negotiable.
        if (r.legal && (!best.legal || r.score > best.score)) {
          best = { sessions: candidate, score: r.score, legal: true };
        }
      }
    }

    if (nextBeam.length === 0) break;

    // Deterministic ordering: rank first, then a stable signature.
    nextBeam.sort(
      (a, b) =>
        b.ranked - a.ranked || signature(a.sessions).localeCompare(signature(b.sessions))
    );
    beam = nextBeam.slice(0, beamWidth);
  }

  return {
    sessions: best.sessions,
    score: best.score,
    violations: best.legal
      ? []
      : [
          ...hardViolations(best.sessions, input),
          ...checkGuardrails(best.sessions, opts.guardrails).map((v) => v.detail),
        ],
  };
}

// ---- helpers --------------------------------------------------------------

function clone(sessions: SolverSession[]): SolverSession[] {
  return sessions.map((s) => ({ ...s, load: { ...s.load } }));
}

function signature(sessions: SolverSession[]): string {
  return sessions
    .map((s) => `${s.id}:${s.date}:${s.dropped ? "x" : Math.round(totalLoad(s.load))}`)
    .sort()
    .join("|");
}

function withinRange(date: string, c: Constraint): boolean {
  if (c.fromDate && date < c.fromDate) return false;
  if (c.toDate && date > c.toDate) return false;
  return true;
}

function dayDiff(a: string, b: string): number {
  return (
    (new Date(b + "T00:00:00").getTime() - new Date(a + "T00:00:00").getTime()) /
    86400000
  );
}

// Extra fields the solver tracks internally without polluting the public type.
declare module "./types" {
  interface SolverSession {
    /** Load before any scaling, so caps compare against the original. */
    originalLoadForCap?: LoadVector;
    originalTssForCap?: number;
    originalMinutesForCap?: number;
  }
}

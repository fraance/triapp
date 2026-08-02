/**
 * Guardrail warnings for a proposed plan layout.
 *
 * Split out from `reschedule.ts` so the browser can run it. The calendar needs
 * to warn the moment a card lands, not once the athlete commits — being told
 * after saving that the arrangement was risky is feedback arriving too late to
 * be useful. Everything this depends on is pure arithmetic, so the same code
 * runs client-side for the live warning and server-side for the authoritative
 * one at save time.
 *
 * Warnings never block. The athlete knows things we do not — a physio
 * appointment, how their legs actually feel — so we say what an arrangement
 * risks and let them decide.
 */
import { checkGuardrails, GuardrailViolation } from "./adaptation/guardrails";
import { loadVectorFor } from "./adaptation/load-vector";
import { SolverSession, ZERO_LOAD } from "./adaptation/types";

/** Statuses that represent a plan, rather than a record of what happened. */
export const MOVABLE_STATUSES = ["planned", "adapted"];

/**
 * Guardrails that are about *where a session sits*, which is the only thing a
 * drag can change.
 *
 * The ramp and ACWR rules are deliberately excluded: they depend on completed
 * training history, they are the adaptation engine's job, and firing them here
 * would mean warning the athlete about something their drag did not cause.
 */
const PLACEMENT_RULES = [
  "same_day_separation",
  "key_session_separation",
  "run_before_bike",
];

export interface RescheduleWarning {
  rule: string;
  detail: string;
  /** Days involved, so the calendar can mark them. */
  dates: string[];
}

export interface WarnableSession {
  id: string;
  /** ISO yyyy-mm-dd. */
  date: string;
  discipline: string;
  type: string;
  tss: number;
  isAnchor: boolean;
  status: string;
}

/**
 * What the athlete should know about an arrangement, without stopping them.
 *
 * Pure: no database, no clock, no randomness. Given the same sessions it
 * always returns the same warnings, which is what makes it testable and what
 * lets the client and the server agree.
 */
export function warningsFor(sessions: WarnableSession[]): RescheduleWarning[] {
  const solverSessions: SolverSession[] = sessions
    .filter((s) => MOVABLE_STATUSES.includes(s.status))
    .map((s) => ({
      id: s.id,
      date: s.date,
      discipline: s.discipline,
      type: s.type,
      durationMinutes: 0,
      tss: s.tss,
      load: loadVectorFor({
        discipline: s.discipline,
        tss: s.tss,
        type: s.type,
      }),
      purpose: s.type,
      isAnchor: s.isAnchor,
      status: s.status,
    }));

  const violations: GuardrailViolation[] = checkGuardrails(solverSessions, {
    // The placement rules we keep don't read either of these; passing zero
    // keeps this function pure rather than dragging in training history.
    chronicLoad: ZERO_LOAD,
    previousWeekLoad: ZERO_LOAD,
  });

  return violations
    .filter((v) => PLACEMENT_RULES.includes(v.rule))
    .map((v) => ({
      rule: v.rule,
      detail: v.detail,
      dates: [...v.detail.matchAll(/\d{4}-\d{2}-\d{2}/g)].map((m) => m[0]),
    }));
}

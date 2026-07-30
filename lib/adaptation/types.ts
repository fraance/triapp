/**
 * Shared types for the adaptation engine.
 *
 * The architectural rule from the spec (Part 1): signal engines are **pure
 * functions**. They read state and return constraints. Only the solver writes
 * the plan. Everything here exists to make that boundary explicit in the type
 * system.
 */

// ---- Load vectors (spec 2.3) ---------------------------------------------

/**
 * A single TSS number conflates costs that recover at very different rates.
 * Tracking four components lets the engine reason about *what* is fatigued.
 */
export interface LoadVector {
  /** Aerobic / systemic cost. */
  metabolic: number;
  /** Eccentric damage — highest in running, slow to clear. */
  mechanical: number;
  /** High-intensity, sprint and threshold work — slowest to recover. */
  neuromuscular: number;
  /** Swim-specific upper-body loading. */
  upper: number;
}

export const ZERO_LOAD: LoadVector = {
  metabolic: 0,
  mechanical: 0,
  neuromuscular: 0,
  upper: 0,
};

export type LoadComponent = keyof LoadVector;

export const LOAD_COMPONENTS: LoadComponent[] = [
  "metabolic",
  "mechanical",
  "neuromuscular",
  "upper",
];

// ---- Constraints (spec 2.2) ----------------------------------------------

export type ConstraintType = "hard" | "soft";

export type ConstraintKind =
  /** No session above the given intensity on the given date. */
  | "max_intensity"
  /** Cap a load component over a date range. */
  | "cap_load"
  /** This date must be rest / no training. */
  | "rest_day"
  /** Keep a session in place — anchors, races, immovable long runs. */
  | "immovable"
  /** Minimum separation, in hours, between heavy uses of a component. */
  | "separation"
  /** Athlete/time/equipment availability. */
  | "availability";

/**
 * The only thing a signal engine may emit. Hard constraints are inviolable;
 * soft constraints become weighted penalties in the solver's objective.
 */
export interface Constraint {
  kind: ConstraintKind;
  type: ConstraintType;
  /** Which engine produced it — shown to the athlete and used in the log. */
  source: string;
  /** Plain-English reason, used by the narrator. */
  reason: string;
  /** ISO date (yyyy-mm-dd) this applies to, or a range. */
  fromDate?: string;
  toDate?: string;
  /** For cap_load / max_intensity. */
  component?: LoadComponent;
  /** Fraction of normal, e.g. 0.5 = cap at half. */
  factor?: number;
  /** Absolute ceiling where a factor makes no sense. */
  limit?: number;
  /** Session ids this applies to, when targeted. */
  sessionIds?: string[];
  /** Penalty weight for soft constraints (higher = more important). */
  weight?: number;
}

/** Signal engines may also express preferences, which never block anything. */
export interface Preference {
  source: string;
  reason: string;
  /** e.g. "prefer_indoor", "prefer_move_later" */
  key: string;
  weight: number;
}

export interface SignalOutput {
  constraints: Constraint[];
  preferences: Preference[];
  /** Anything the engine wants recorded in the adaptation cause. */
  facts?: Record<string, unknown>;
}

// ---- Sessions the solver works on ----------------------------------------

/**
 * A plan session in the form the solver understands. Deliberately a plain
 * object, not a Prisma model, so the solver stays pure and testable.
 */
export interface SolverSession {
  id: string;
  /** ISO yyyy-mm-dd. */
  date: string;
  discipline: string;
  type: string;
  durationMinutes: number;
  tss: number;
  load: LoadVector;
  /** What the session is for; preserved even when its shape changes. */
  purpose: string;
  /** Anchor sessions must survive every adaptation (spec 3.2). */
  isAnchor: boolean;
  status: string;
  /** Set by the solver when it changes something. */
  movedFrom?: string;
  scaledBy?: number;
  dropped?: boolean;
}

export interface SolverInput {
  /** Today, as ISO yyyy-mm-dd, in the athlete's local time. */
  today: string;
  /** Sessions inside the planning horizon, in date order. */
  sessions: SolverSession[];
  constraints: Constraint[];
  preferences: Preference[];
  /** Rolling chronic load, used for ramp/ACWR guardrails. */
  chronicLoad: LoadVector;
  /** Days the athlete cannot train at all (from availability). */
  unavailableDates?: string[];
  /** Sessions on/before this date are frozen (commitment window). */
  frozenUntil?: string;
}

export interface SolverResult {
  sessions: SolverSession[];
  score: number;
  /** Hard constraints that could not be satisfied, if any. */
  violations: string[];
}

// ---- Diffs and events ----------------------------------------------------

export interface SessionChange {
  sessionId: string;
  discipline: string;
  /** "moved" | "scaled" | "dropped" | "retyped" */
  change: string;
  fromDate?: string;
  toDate?: string;
  fromTss?: number;
  toTss?: number;
  fromType?: string;
  toType?: string;
}

export interface PlanDiff {
  changes: SessionChange[];
  /** True when nothing meaningful changed. */
  empty: boolean;
}

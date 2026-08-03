/**
 * Physiological state tracking (v3 §2.1).
 *
 * Two things the spec asks for, both deliberately conservative:
 *
 * 1. **Threshold confidence.** "Every threshold (FTP, CSS, vDOT) carries a
 *    confidence score that decays over time and rises with executions. Below
 *    0.4, the engine prescribes in RPE and schedules a test."
 *
 *    This matters because a stale threshold is worse than no threshold: it
 *    produces confident, precise, wrong paces. An athlete training to an FTP
 *    measured five months ago is training to a number that no longer describes
 *    them, and the engine has no way to know unless it tracks decay.
 *
 * 2. **Metabolic state.** Estimated glycogen depletion from trailing 48-hour
 *    load, turned into fuelling constraints. Note the word *estimated* — this
 *    is a model, not a measurement, and it is labelled as such everywhere it
 *    surfaces.
 *
 * All pure functions: state in, constraints out. No database, no clock beyond
 * an injected `now`, so every decision is reproducible.
 */
import { Constraint, LoadVector } from "./types";
import { totalLoad, localISO } from "./load-vector";

// ---- Threshold confidence -------------------------------------------------

export type ThresholdKind = "ftp" | "css" | "runThreshold" | "maxHr" | "thresholdHr";

/** Below this, prescribe in RPE and schedule a test (v3 §2.1). */
export const RPE_CONFIDENCE_FLOOR = 0.4;
/** v3 §3.4: test injection triggers here. */
export const TEST_INJECTION_THRESHOLD = 0.5;

/**
 * Half-life in days for each threshold's confidence.
 *
 * These differ because the underlying qualities drift at different rates:
 * swim CSS is largely technique and holds for months; FTP moves with training
 * state within weeks; max HR is close to a fixed trait and barely decays.
 */
const HALF_LIFE_DAYS: Record<ThresholdKind, number> = {
  ftp: 42,
  css: 90,
  runThreshold: 56,
  maxHr: 365,
  thresholdHr: 120,
};

export interface ThresholdObservation {
  /** When the value was measured or last corroborated. */
  at: Date;
  /**
   * How strong the evidence was. A dedicated test is 1; a value inferred from
   * ordinary training is weaker and should say so.
   */
  strength?: number;
}

export interface ThresholdConfidence {
  kind: ThresholdKind;
  value: number | null;
  confidence: number;
  ageDays: number | null;
  /** Prescribe in RPE rather than in numbers. */
  useRpe: boolean;
  /** A test should be scheduled. */
  needsTest: boolean;
  basis: string;
}

/**
 * Confidence in a threshold: exponential decay from when it was established,
 * raised by every subsequent execution that corroborates it.
 *
 * A threshold we never measured has confidence 0 — not a default, and never a
 * guess (project rule 2).
 */
export function thresholdConfidence(
  kind: ThresholdKind,
  value: number | null | undefined,
  observations: ThresholdObservation[],
  now: Date
): ThresholdConfidence {
  if (value == null || !Number.isFinite(value) || value <= 0) {
    return {
      kind,
      value: null,
      confidence: 0,
      ageDays: null,
      useRpe: true,
      needsTest: true,
      basis: "never measured",
    };
  }

  if (observations.length === 0) {
    return {
      kind,
      value,
      confidence: 0,
      ageDays: null,
      useRpe: true,
      needsTest: true,
      basis: "value present but we cannot date it, so it cannot be trusted",
    };
  }

  const halfLife = HALF_LIFE_DAYS[kind];
  const newest = observations.reduce((a, b) => (a.at > b.at ? a : b));
  const ageDays = Math.max(
    0,
    Math.floor((now.getTime() - newest.at.getTime()) / 86400000)
  );

  // Decay from the most recent evidence.
  const decayed = Math.pow(0.5, ageDays / halfLife) * (newest.strength ?? 1);

  // Corroboration: each additional recent observation adds a little, with
  // sharply diminishing returns so a burst of sessions cannot fake certainty.
  const recent = observations.filter(
    (o) => (now.getTime() - o.at.getTime()) / 86400000 <= halfLife
  ).length;
  const corroboration = 1 + Math.min(0.25, Math.log1p(Math.max(0, recent - 1)) * 0.1);

  const confidence = Math.max(0, Math.min(1, decayed * corroboration));

  return {
    kind,
    value,
    confidence: Math.round(confidence * 100) / 100,
    ageDays,
    useRpe: confidence < RPE_CONFIDENCE_FLOOR,
    needsTest: confidence < TEST_INJECTION_THRESHOLD,
    basis:
      `last corroborated ${ageDays} day${ageDays === 1 ? "" : "s"} ago` +
      (recent > 1 ? `, ${recent} supporting sessions` : ""),
  };
}

/** Everything the coach needs to know about how much to trust its numbers. */
export interface ThresholdReport {
  thresholds: ThresholdConfidence[];
  /** Kinds that must be prescribed in RPE. */
  rpeOnly: ThresholdKind[];
  /** Kinds that warrant a test being scheduled. */
  testsNeeded: ThresholdKind[];
  summary: string;
}

export function buildThresholdReport(
  entries: ThresholdConfidence[]
): ThresholdReport {
  const rpeOnly = entries.filter((e) => e.useRpe && e.value != null).map((e) => e.kind);
  const testsNeeded = entries.filter((e) => e.needsTest).map((e) => e.kind);

  const parts = entries
    .filter((e) => e.value != null)
    .map((e) => `${e.kind} ${Math.round(e.confidence * 100)}%`);

  return {
    thresholds: entries,
    rpeOnly,
    testsNeeded,
    summary:
      parts.length > 0
        ? `Threshold confidence: ${parts.join(", ")}.` +
          (rpeOnly.length > 0
            ? ` Prescribe ${rpeOnly.join(" and ")} by feel, not by numbers.`
            : "")
        : "No thresholds established.",
  };
}

// ---- Metabolic state ------------------------------------------------------

/**
 * Glycogen store, as a fraction of full.
 *
 * A deliberately simple model: trailing load depletes, time replenishes. It is
 * an estimate and is labelled as one — we have no nutrition data, so this must
 * never be presented as a measurement.
 */
export interface MetabolicState {
  /** 0..1, where 1 is fully fuelled. */
  glycogen: number;
  /** Load carried in the trailing 48 hours. */
  trailing48hLoad: number;
  /** "fuelled" | "moderate" | "depleted" */
  band: "fuelled" | "moderate" | "depleted";
  estimated: true;
  basis: string;
}

/** Load in a day that would roughly empty a well-fuelled athlete. */
const FULL_DEPLETION_LOAD = 220;
/** Fraction of stores recovered per day of normal eating. */
const DAILY_REPLENISH = 0.55;

export function metabolicState(
  dailyLoads: Array<{ date: string; load: LoadVector }>,
  now: Date
): MetabolicState {
  const today = localISO(now);
  const yesterday = localISO(new Date(now.getTime() - 86400000));

  const loadOn = (iso: string) =>
    dailyLoads
      .filter((d) => d.date === iso)
      .reduce((n, d) => n + totalLoad(d.load), 0);

  const todayLoad = loadOn(today);
  const yesterdayLoad = loadOn(yesterday);
  const trailing = todayLoad + yesterdayLoad;

  // Yesterday depletes, then one night replenishes, then today depletes again.
  let glycogen = 1 - yesterdayLoad / FULL_DEPLETION_LOAD;
  glycogen = Math.min(1, Math.max(0, glycogen) + DAILY_REPLENISH);
  glycogen = Math.max(0, glycogen - todayLoad / FULL_DEPLETION_LOAD);

  const band: MetabolicState["band"] =
    glycogen >= 0.7 ? "fuelled" : glycogen >= 0.4 ? "moderate" : "depleted";

  return {
    glycogen: Math.round(glycogen * 100) / 100,
    trailing48hLoad: Math.round(trailing),
    band,
    estimated: true,
    basis: `${Math.round(yesterdayLoad)} load yesterday, ${Math.round(todayLoad)} today`,
  };
}

/**
 * Metabolic constraints (v3 §2.1: "converting this into fueling constraints").
 *
 * Depleted stores do not stop training — they change what training is *useful*.
 * A hard session on empty produces fatigue without adaptation, so intensity is
 * capped rather than volume.
 */
export function metabolicEngine(
  state: MetabolicState,
  today: string
): { constraints: Constraint[]; facts: Record<string, unknown> } {
  const constraints: Constraint[] = [];

  const tomorrow = new Date(today + "T00:00:00");
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowISO = localISO(tomorrow);

  if (state.band === "depleted") {
    constraints.push({
      kind: "max_intensity",
      type: "hard",
      source: "metabolic_state",
      reason:
        `Estimated glycogen is low after ${state.trailing48hLoad} load in 48 hours. ` +
        `High intensity on empty stores produces fatigue without adaptation, so ` +
        `today's intensity is capped.`,
      fromDate: today,
      toDate: today,
      component: "neuromuscular",
      factor: 0.5,
    });
  } else if (state.band === "moderate") {
    constraints.push({
      kind: "cap_load",
      type: "soft",
      source: "metabolic_state",
      reason:
        `Estimated glycogen is only partly restored after ${state.trailing48hLoad} ` +
        `load in 48 hours.`,
      fromDate: today,
      toDate: tomorrowISO,
      factor: 0.9,
      weight: 1,
    });
  }

  return {
    constraints,
    facts: {
      glycogen: state.glycogen,
      band: state.band,
      trailing48hLoad: state.trailing48hLoad,
      estimated: true,
    },
  };
}

/**
 * Vectorized load (spec Part 2.3).
 *
 * A single TSS number cannot tell the engine *what* is tired. A 90-minute run
 * and a 90-minute ride can share a TSS while doing completely different damage:
 * the run loads mechanically (eccentric, slow to clear), the ride mostly
 * metabolically. Splitting load into four components is what lets the solver
 * say "you can ride hard today, but not run".
 *
 * Everything here is a pure function of data we actually hold. Where a value
 * cannot be sourced it is left at zero rather than guessed (project rule 2).
 */
import { LoadVector, ZERO_LOAD, LOAD_COMPONENTS, LoadComponent } from "./types";

/**
 * How each discipline distributes a unit of training stress across the four
 * components. Rows sum to roughly 1.0 for a steady effort; intensity then
 * shifts weight towards neuromuscular (see `intensityFactor`).
 *
 * These are coaching heuristics, not measurements — they are deliberately
 * coarse, and they are the single place to tune discipline cost.
 */
const DISCIPLINE_PROFILE: Record<
  string,
  { metabolic: number; mechanical: number; neuromuscular: number; upper: number }
> = {
  //                       metabolic  mechanical  neuromuscular  upper
  run: { metabolic: 0.55, mechanical: 0.35, neuromuscular: 0.1, upper: 0 },
  bike: { metabolic: 0.75, mechanical: 0.1, neuromuscular: 0.15, upper: 0 },
  swim: { metabolic: 0.5, mechanical: 0.05, neuromuscular: 0.1, upper: 0.35 },
  strength: { metabolic: 0.2, mechanical: 0.4, neuromuscular: 0.25, upper: 0.15 },
  brick: { metabolic: 0.65, mechanical: 0.25, neuromuscular: 0.1, upper: 0 },
  other: { metabolic: 0.6, mechanical: 0.2, neuromuscular: 0.2, upper: 0 },
};

/** Maps the many names Strava and the AI coach use onto our profile keys. */
export function normaliseDiscipline(raw: string | null | undefined): string {
  const d = (raw || "").toLowerCase();
  if (!d) return "other";
  if (d.includes("swim")) return "swim";
  if (d.includes("brick")) return "brick";
  if (
    d.includes("bike") ||
    d.includes("ride") ||
    d.includes("cycl") ||
    d.includes("velo")
  )
    return "bike";
  if (d.includes("run") || d.includes("jog")) return "run";
  if (
    d.includes("strength") ||
    d.includes("gym") ||
    d.includes("weight") ||
    d.includes("core") ||
    d.includes("renfo") ||
    d.includes("workout")
  )
    return "strength";
  if (d.includes("rest")) return "rest";
  return "other";
}

/**
 * How hard a session is, on a 0..1-ish scale, from its type/name.
 *
 * Intensity matters because neuromuscular cost is driven by it, not by volume.
 * Unknown types return `null` — the caller then treats the session as steady
 * rather than inventing an intensity.
 */
export function intensityFromType(type: string | null | undefined): number | null {
  const t = (type || "").toLowerCase();
  if (!t) return null;
  if (/(recovery|easy|regen|shakeout|mobility)/.test(t)) return 0.15;
  if (/(endurance|base|steady|long|aerobic|technique|drill)/.test(t)) return 0.35;
  if (/(tempo|sweet ?spot|progressive|strength)/.test(t)) return 0.6;
  if (/(threshold|lactate|css|ftp)/.test(t)) return 0.8;
  if (/(vo2|interval|sprint|race|hill repeat|speed|anaerobic)/.test(t)) return 1.0;
  return null;
}

/**
 * Shifts load towards neuromuscular as intensity rises.
 * At intensity 0.35 (steady) the profile is unchanged; at 1.0 a meaningful
 * slice of the cost is reclassified as neuromuscular.
 */
function applyIntensity(
  base: { metabolic: number; mechanical: number; neuromuscular: number; upper: number },
  intensity: number
) {
  const shift = Math.max(0, intensity - 0.35) * 0.5;
  const fromMetabolic = base.metabolic * shift;
  const fromMechanical = base.mechanical * shift * 0.5;
  return {
    metabolic: base.metabolic - fromMetabolic,
    mechanical: base.mechanical - fromMechanical,
    neuromuscular: base.neuromuscular + fromMetabolic + fromMechanical,
    upper: base.upper,
  };
}

export interface LoadInput {
  discipline: string | null | undefined;
  /** Training stress for the session. */
  tss: number;
  /** Session type/name, used to infer intensity. */
  type?: string | null;
  /** Overrides the inferred intensity when we know it. */
  intensity?: number | null;
  /** Running distance in km, for the mechanical-impact adjustment. */
  distanceKm?: number | null;
  /** Elevation gain in metres — descending adds eccentric damage. */
  elevationGainM?: number | null;
}

/**
 * Converts one session (planned or completed) into a load vector.
 */
export function loadVectorFor(input: LoadInput): LoadVector {
  const discipline = normaliseDiscipline(input.discipline);
  if (discipline === "rest") return { ...ZERO_LOAD };

  const tss = Number.isFinite(input.tss) ? Math.max(0, input.tss) : 0;
  if (tss === 0) return { ...ZERO_LOAD };

  const base = DISCIPLINE_PROFILE[discipline] ?? DISCIPLINE_PROFILE.other;
  const intensity =
    input.intensity ?? intensityFromType(input.type) ?? 0.35; // steady default
  const profile = applyIntensity(base, intensity);

  const vector: LoadVector = {
    metabolic: tss * profile.metabolic,
    mechanical: tss * profile.mechanical,
    neuromuscular: tss * profile.neuromuscular,
    upper: tss * profile.upper,
  };

  // Long descents add eccentric damage beyond what TSS captures. Only applied
  // when we actually have the data.
  if (
    discipline === "run" &&
    typeof input.elevationGainM === "number" &&
    typeof input.distanceKm === "number" &&
    input.distanceKm > 0
  ) {
    const mPerKm = input.elevationGainM / input.distanceKm;
    if (mPerKm > 10) {
      // Cap the uplift so a freak value cannot dominate the vector.
      const uplift = Math.min(0.35, (mPerKm - 10) / 100);
      vector.mechanical *= 1 + uplift;
    }
  }

  return round(vector);
}

function round(v: LoadVector): LoadVector {
  return {
    metabolic: Math.round(v.metabolic * 10) / 10,
    mechanical: Math.round(v.mechanical * 10) / 10,
    neuromuscular: Math.round(v.neuromuscular * 10) / 10,
    upper: Math.round(v.upper * 10) / 10,
  };
}

export function addLoad(a: LoadVector, b: LoadVector): LoadVector {
  return round({
    metabolic: a.metabolic + b.metabolic,
    mechanical: a.mechanical + b.mechanical,
    neuromuscular: a.neuromuscular + b.neuromuscular,
    upper: a.upper + b.upper,
  });
}

export function sumLoad(vectors: LoadVector[]): LoadVector {
  return vectors.reduce(addLoad, { ...ZERO_LOAD });
}

export function scaleLoad(v: LoadVector, factor: number): LoadVector {
  return round({
    metabolic: v.metabolic * factor,
    mechanical: v.mechanical * factor,
    neuromuscular: v.neuromuscular * factor,
    upper: v.upper * factor,
  });
}

/** Total stress across all components — the scalar TSS equivalent. */
export function totalLoad(v: LoadVector): number {
  return (
    Math.round(
      (v.metabolic + v.mechanical + v.neuromuscular + v.upper) * 10
    ) / 10
  );
}

/**
 * Exponentially-weighted average of daily load, the standard way to express
 * chronic (fitness) and acute (fatigue) training load.
 *
 * @param dailyLoads oldest-first list of per-day vectors.
 * @param days time constant — 42 for chronic, 7 for acute.
 */
export function ewma(dailyLoads: LoadVector[], days: number): LoadVector {
  if (dailyLoads.length === 0) return { ...ZERO_LOAD };
  const alpha = 2 / (days + 1);
  let acc: LoadVector = { ...ZERO_LOAD };
  for (const day of dailyLoads) {
    for (const k of LOAD_COMPONENTS) {
      acc[k] = day[k] * alpha + acc[k] * (1 - alpha);
    }
  }
  return round(acc);
}

/**
 * Acute:Chronic Workload Ratio per component.
 * A chronic load of zero yields 0 rather than Infinity — a brand new athlete
 * has no ratio, and pretending otherwise would block all training.
 */
export function acwr(acute: LoadVector, chronic: LoadVector): LoadVector {
  const out = {} as LoadVector;
  for (const k of LOAD_COMPONENTS) {
    out[k] = chronic[k] > 0 ? Math.round((acute[k] / chronic[k]) * 100) / 100 : 0;
  }
  return out;
}

/**
 * Formats a Date as yyyy-mm-dd in **local** time.
 *
 * `toISOString().slice(0,10)` is a trap here: dates in this engine are built
 * as local midnight, and converting those to UTC in any positive offset rolls
 * them back to the previous day. That silently misaligned whole load series.
 */
export function localISO(d: Date): string {
  return (
    `${d.getFullYear()}-` +
    `${String(d.getMonth() + 1).padStart(2, "0")}-` +
    `${String(d.getDate()).padStart(2, "0")}`
  );
}

/**
 * Buckets sessions into per-day load vectors across a date range, so EWMA has
 * an unbroken series including rest days (which matter — they are the zeros).
 */
export function dailySeries(
  entries: Array<{ date: string; load: LoadVector }>,
  fromISO: string,
  toISO: string
): LoadVector[] {
  const byDate = new Map<string, LoadVector>();
  for (const e of entries) {
    byDate.set(e.date, addLoad(byDate.get(e.date) ?? { ...ZERO_LOAD }, e.load));
  }
  const out: LoadVector[] = [];
  const cursor = new Date(fromISO + "T00:00:00");
  const end = new Date(toISO + "T00:00:00");
  while (cursor <= end) {
    out.push(byDate.get(localISO(cursor)) ?? { ...ZERO_LOAD });
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

export type { LoadComponent };

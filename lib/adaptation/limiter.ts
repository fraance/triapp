/**
 * Limiter analysis (v3 §3.1).
 *
 * > "Focus is allocated by ROI — disciplines are ranked by time lost vs.
 * >  target on the A-race course."
 *
 * The honest difficulty: "time lost vs target" needs a target, and we do not
 * have age-group benchmark tables. Inventing one would be exactly the
 * confident-sounding fabrication project rule 2 forbids.
 *
 * So ROI is computed two ways, and only from data we actually hold:
 *
 *  1. **Sensitivity ROI (always available).** For a fixed capability gain in
 *     each discipline, how many minutes does the athlete save *on this course*?
 *     This needs no external benchmark and is genuinely what a coach means by
 *     return on investment: five percent off a 3-hour bike split is worth far
 *     more than five percent off a 35-minute swim, and a mountainous course
 *     shifts that further still.
 *
 *  2. **Deficit ROI (only with a goal time).** If the athlete has stated a
 *     target finish time, the shortfall against a pro-rata split is reported.
 *     Without a goal time this is left null rather than guessed.
 *
 * Every prediction is derived from measured athlete data. Where a metric is
 * missing the discipline returns null and is excluded — it is never estimated
 * into existence.
 */

export type Discipline = "swim" | "bike" | "run";

/** Segment distances by race type. */
const DISTANCES: Record<string, { swimM: number; bikeKm: number; runKm: number }> = {
  sprint: { swimM: 750, bikeKm: 20, runKm: 5 },
  olympic: { swimM: 1500, bikeKm: 40, runKm: 10 },
  "70.3": { swimM: 1900, bikeKm: 90, runKm: 21.1 },
  full: { swimM: 3800, bikeKm: 180, runKm: 42.2 },
};

export function distancesFor(raceType: string | null | undefined) {
  const t = (raceType || "").toLowerCase();
  if (t.includes("sprint")) return DISTANCES.sprint;
  if (t.includes("70.3") || t.includes("half")) return DISTANCES["70.3"];
  if (t.includes("full") || t.includes("ironman") || t.includes("140.6"))
    return DISTANCES.full;
  if (t.includes("olympic") || t.includes("standard")) return DISTANCES.olympic;
  return null;
}

export interface AthleteCapability {
  /** Critical swim speed, seconds per 100 m. */
  swimCssSecPer100?: number | null;
  /** Median moving speed on rides, m/s — measured, not modelled. */
  bikeSpeedMs?: number | null;
  /** Threshold run pace, seconds per km. */
  runThresholdPaceSec?: number | null;
}

export interface CourseProfile {
  raceType?: string | null;
  swimEnvironment?: string | null;
  wetsuitLikely?: boolean | null;
  bikeElevationGainM?: number | null;
  runElevationGainM?: number | null;
  runSurface?: string | null;
}

export interface DisciplineEstimate {
  discipline: Discipline;
  /** Predicted split on this course, in seconds. Null when unmeasurable. */
  predictedSec: number | null;
  /** Minutes saved on race day per 5 % capability gain. */
  minutesPer5Pct: number | null;
  /** 0..1 share of the total available gain — the ROI ranking. */
  roi: number;
  /** Seconds above a pro-rata goal split, when a goal time exists. */
  deficitSec: number | null;
  basis: string;
}

export interface LimiterAnalysis {
  hasData: boolean;
  estimates: DisciplineEstimate[];
  /** Disciplines ordered by ROI, highest first. */
  ranked: Discipline[];
  /** ROI keyed by discipline, for the salvage engine's priority weighting. */
  priority: Record<string, number>;
  predictedTotalSec: number | null;
  goalSec: number | null;
  notes: string[];
}

/** Open water and wetsuit adjustments to pool-derived swim speed. */
function swimCourseFactor(course: CourseProfile): { factor: number; note: string } {
  const env = (course.swimEnvironment || "").toLowerCase();
  let factor = 1;
  const parts: string[] = [];
  if (env && !env.includes("pool")) {
    factor *= 1.06; // sighting, no push-offs
    parts.push("open water +6%");
  }
  if (course.wetsuitLikely) {
    factor *= 0.96;
    parts.push("wetsuit -4%");
  }
  return { factor, note: parts.join(", ") || "pool-equivalent" };
}

/** Climbing slows a bike split; metres per km is the usable signal. */
function bikeCourseFactor(course: CourseProfile, bikeKm: number) {
  const gain = course.bikeElevationGainM;
  if (gain == null || bikeKm <= 0) return { factor: 1, note: "no elevation data" };
  const mPerKm = gain / bikeKm;
  // ~1 % slower per 5 m/km of climbing, capped so a freak value cannot dominate.
  const factor = 1 + Math.min(0.35, (mPerKm / 5) * 0.01);
  return { factor, note: `${Math.round(mPerKm)} m/km climbing` };
}

function runCourseFactor(course: CourseProfile, runKm: number) {
  const parts: string[] = [];
  let factor = 1;
  const gain = course.runElevationGainM;
  if (gain != null && runKm > 0) {
    const mPerKm = gain / runKm;
    factor *= 1 + Math.min(0.25, (mPerKm / 10) * 0.01);
    parts.push(`${Math.round(mPerKm)} m/km climbing`);
  }
  const surface = (course.runSurface || "").toLowerCase();
  if (surface.includes("trail")) {
    factor *= 1.08;
    parts.push("trail +8%");
  }
  return { factor, note: parts.join(", ") || "flat road assumed absent data" };
}

/**
 * Race-pace multipliers relative to threshold. Long-course racing is run well
 * below threshold; these are coaching conventions, deliberately coarse, and
 * kept in one place so they can be tuned.
 */
function runRacePaceFactor(runKm: number): number {
  if (runKm <= 5.5) return 1.0;
  if (runKm <= 10.5) return 1.04;
  if (runKm <= 22) return 1.1;
  return 1.18;
}

function bikeRaceIntensity(bikeKm: number): number {
  if (bikeKm <= 25) return 1.0;
  if (bikeKm <= 45) return 0.95;
  if (bikeKm <= 95) return 0.85;
  return 0.75;
}

const GAIN = 0.05; // the capability improvement ROI is measured against

/**
 * Ranks disciplines by how much race time a fixed capability gain would save.
 *
 * Pure function — no database, no clock.
 */
export function analyseLimiters(
  capability: AthleteCapability,
  course: CourseProfile,
  opts: { goalTimeSec?: number | null } = {}
): LimiterAnalysis {
  const notes: string[] = [];
  const dist = distancesFor(course.raceType);

  if (!dist) {
    return {
      hasData: false,
      estimates: [],
      ranked: [],
      priority: {},
      predictedTotalSec: null,
      goalSec: opts.goalTimeSec ?? null,
      notes: ["Race distance is unknown, so no course-specific analysis is possible."],
    };
  }

  const swimAdj = swimCourseFactor(course);
  const bikeAdj = bikeCourseFactor(course, dist.bikeKm);
  const runAdj = runCourseFactor(course, dist.runKm);

  /** Predicted split for a given capability multiplier (1 = today). */
  const swimAt = (mult: number) =>
    capability.swimCssSecPer100 != null && capability.swimCssSecPer100 > 0
      ? (dist.swimM / 100) * (capability.swimCssSecPer100 / mult) * swimAdj.factor
      : null;

  const bikeAt = (mult: number) =>
    capability.bikeSpeedMs != null && capability.bikeSpeedMs > 0
      ? (dist.bikeKm * 1000) /
        (capability.bikeSpeedMs * mult * bikeRaceIntensity(dist.bikeKm)) *
        bikeAdj.factor
      : null;

  const runAt = (mult: number) =>
    capability.runThresholdPaceSec != null && capability.runThresholdPaceSec > 0
      ? dist.runKm *
        (capability.runThresholdPaceSec / mult) *
        runRacePaceFactor(dist.runKm) *
        runAdj.factor
      : null;

  const raw: Array<{
    discipline: Discipline;
    now: number | null;
    better: number | null;
    basis: string;
  }> = [
    {
      discipline: "swim",
      now: swimAt(1),
      better: swimAt(1 + GAIN),
      basis:
        capability.swimCssSecPer100 != null
          ? `CSS ${capability.swimCssSecPer100}s/100m, ${swimAdj.note}`
          : "no swim CSS measured",
    },
    {
      discipline: "bike",
      now: bikeAt(1),
      better: bikeAt(1 + GAIN),
      basis:
        capability.bikeSpeedMs != null
          ? `${(capability.bikeSpeedMs * 3.6).toFixed(1)} km/h measured, ${bikeAdj.note}`
          : "no ride speed measured",
    },
    {
      discipline: "run",
      now: runAt(1),
      better: runAt(1 + GAIN),
      basis:
        capability.runThresholdPaceSec != null
          ? `threshold ${Math.round(capability.runThresholdPaceSec)}s/km, ${runAdj.note}`
          : "no run threshold measured",
    },
  ];

  const savings = raw.map((r) =>
    r.now != null && r.better != null ? (r.now - r.better) / 60 : null
  );
  const totalSaving = savings.reduce<number>((n, s) => n + (s ?? 0), 0);

  const measured = raw.filter((r) => r.now != null);
  const predictedTotalSec =
    measured.length === raw.length
      ? raw.reduce<number>((n, r) => n + (r.now ?? 0), 0)
      : null;

  for (const r of raw) {
    if (r.now == null) {
      notes.push(`${r.discipline}: ${r.basis} — excluded from the ranking.`);
    }
  }

  const goalSec = opts.goalTimeSec ?? null;
  if (goalSec == null) {
    notes.push(
      "No goal time set, so 'time lost vs target' cannot be computed. ROI is " +
        "ranked by minutes saved per 5% capability gain instead."
    );
  }

  const estimates: DisciplineEstimate[] = raw.map((r, i) => {
    const saving = savings[i];
    // Pro-rata goal split, only meaningful when we can predict every segment.
    let deficitSec: number | null = null;
    if (goalSec != null && predictedTotalSec != null && r.now != null) {
      const share = r.now / predictedTotalSec;
      deficitSec = Math.round(r.now - goalSec * share);
    }
    return {
      discipline: r.discipline,
      predictedSec: r.now != null ? Math.round(r.now) : null,
      minutesPer5Pct: saving != null ? Math.round(saving * 10) / 10 : null,
      roi:
        saving != null && totalSaving > 0
          ? Math.round((saving / totalSaving) * 100) / 100
          : 0,
      deficitSec,
      basis: r.basis,
    };
  });

  const ranked = estimates
    .filter((e) => e.minutesPer5Pct != null)
    .sort(
      (a, b) =>
        (b.minutesPer5Pct ?? 0) - (a.minutesPer5Pct ?? 0) ||
        a.discipline.localeCompare(b.discipline)
    )
    .map((e) => e.discipline);

  const priority: Record<string, number> = {};
  for (const e of estimates) priority[e.discipline] = e.roi;

  return {
    hasData: ranked.length > 0,
    estimates,
    ranked,
    priority,
    predictedTotalSec: predictedTotalSec != null ? Math.round(predictedTotalSec) : null,
    goalSec,
    notes,
  };
}

/** Short, athlete-readable summary for the coach prompt and the change log. */
export function describeLimiters(a: LimiterAnalysis): string {
  if (!a.hasData) return "Limiter analysis unavailable: " + a.notes.join(" ");
  const top = a.estimates.find((e) => e.discipline === a.ranked[0]);
  return (
    `Biggest return on training: ${a.ranked[0]} ` +
    `(${top?.minutesPer5Pct} min saved per 5% gain). ` +
    `Order: ${a.ranked.join(" > ")}.`
  );
}

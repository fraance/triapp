/**
 * Automated profile ingestion.
 *
 * Reads the athlete's real activity stream and derives the performance metrics
 * a coach needs — FTP, CSS, heart-rate anchors, cadence, volume — so the
 * athlete has to type in as little as possible.
 *
 * Everything returned carries a `source` and `confidence` so we never present
 * an estimate as if it were a measured test result.
 */
import { prisma } from "./prisma";

export type MetricSource = "measured" | "derived" | "missing";
export type Confidence = "high" | "medium" | "low";

export interface DerivedMetric<T = number> {
  value: T | null;
  source: MetricSource;
  confidence: Confidence | null;
  basis?: string; // plain-English explanation of where it came from
  /**
   * What the athlete's DATA says, kept even when they have overridden it.
   * Lets us spot disagreements between their entry and their actual history.
   */
  dataValue?: T | null;
  dataBasis?: string;
}

export interface EquipmentAudit {
  powerMeter: boolean;
  heartRateMonitor: boolean;
  cadenceSensor: boolean;
  gpsWatch: boolean;
  smartTrainer: boolean;
  swimTracking: boolean;
  /** Human-readable evidence for each conclusion. */
  evidence: string[];
}

export interface AthleteMetrics {
  hasActivityData: boolean;
  activityCount: number;
  // Global
  maxHeartRate: DerivedMetric;
  restingHeartRate: DerivedMetric;
  weeklyHours: DerivedMetric;
  // Bike
  ftpWatts: DerivedMetric;
  ftpPerKg: DerivedMetric;
  bikeLthr: DerivedMetric;
  bikeMaxHr: DerivedMetric;
  bikeCadence: DerivedMetric;
  // Run
  runThresholdPaceSec: DerivedMetric;
  runLthr: DerivedMetric;
  runMaxHr: DerivedMetric;
  // Swim
  swimCssSecPer100: DerivedMetric;
  equipment: EquipmentAudit;
}

function metric<T>(
  value: T | null,
  source: MetricSource,
  confidence: Confidence | null = null,
  basis?: string
): DerivedMetric<T> {
  return { value, source, confidence, basis };
}

const EMPTY = metric<number>(null, "missing");

/**
 * Derives everything we can from the athlete's activity history, then lets any
 * value the athlete entered manually take precedence.
 */
export async function deriveAthleteMetrics(
  userId: string
): Promise<AthleteMetrics> {
  const [profile, activities] = await Promise.all([
    prisma.athleteProfile.findUnique({ where: { userId } }),
    prisma.stravaActivity.findMany({
      where: { userId },
      orderBy: { startDate: "desc" },
      take: 500,
    }),
  ]);

  const equipment = auditEquipment(activities);

  if (activities.length === 0) {
    return {
      hasActivityData: false,
      activityCount: 0,
      maxHeartRate: manualOr(profile?.maxHeartRate, EMPTY),
      restingHeartRate: manualOr(profile?.restingHeartRate, EMPTY),
      weeklyHours: EMPTY,
      ftpWatts: manualOr(profile?.ftpWatts, EMPTY),
      ftpPerKg: EMPTY,
      bikeLthr: manualOr(profile?.bikeLthr, EMPTY),
      bikeMaxHr: manualOr(profile?.bikeMaxHr, EMPTY),
      bikeCadence: manualOr(profile?.bikeAvgCadence, EMPTY),
      runThresholdPaceSec: manualOr(profile?.runThresholdPaceSec, EMPTY),
      runLthr: manualOr(profile?.runLthr, EMPTY),
      runMaxHr: manualOr(profile?.runMaxHr, EMPTY),
      swimCssSecPer100: manualOr(profile?.swimCssSecPer100, EMPTY),
      equipment,
    };
  }

  const bikes = activities.filter((a) => a.discipline === "Bike");
  const runs = activities.filter((a) => a.discipline === "Run");
  const swims = activities.filter((a) => a.discipline === "Swim");

  // ---- Heart rate anchors ------------------------------------------------
  const allHr = activities
    .map((a) => a.maxHeartRate)
    .filter((h): h is number => typeof h === "number" && h > 0);
  const observedMax = allHr.length ? Math.round(Math.max(...allHr)) : null;

  const derivedMaxHr = observedMax
    ? metric(
        observedMax,
        "derived",
        allHr.length >= 10 ? "high" : "medium",
        `Highest heart rate seen across ${allHr.length} recorded activities`
      )
    : EMPTY;

  const bikeMaxObserved = maxOf(bikes.map((a) => a.maxHeartRate));
  const runMaxObserved = maxOf(runs.map((a) => a.maxHeartRate));

  // Lactate threshold HR ~ 90% of max for that discipline (standard estimate).
  const derivedBikeLthr = bikeMaxObserved
    ? metric(
        Math.round(bikeMaxObserved * 0.9),
        "derived",
        "low",
        "Estimated as 90% of your highest bike heart rate — a proper test is more accurate"
      )
    : EMPTY;
  const derivedRunLthr = runMaxObserved
    ? metric(
        Math.round(runMaxObserved * 0.9),
        "derived",
        "low",
        "Estimated as 90% of your highest run heart rate — a proper test is more accurate"
      )
    : EMPTY;

  // ---- Cycling FTP -------------------------------------------------------
  // Without power-curve data we approximate from the best sustained average
  // power on rides of at least 20 minutes: FTP ~ 95% of that effort.
  const poweredRides = bikes.filter(
    (a) => typeof a.avgWatts === "number" && a.avgWatts > 0 && a.movingTime >= 1200
  );
  let derivedFtp: DerivedMetric = EMPTY;
  if (poweredRides.length > 0) {
    const best = Math.max(...poweredRides.map((a) => a.avgWatts as number));
    derivedFtp = metric(
      Math.round(best * 0.95),
      "derived",
      poweredRides.length >= 5 ? "medium" : "low",
      `Estimated from your strongest sustained ride power across ${poweredRides.length} rides with a power meter`
    );
  }

  // ---- Run threshold pace ------------------------------------------------
  // Use the fastest average pace held for 20+ minutes as a threshold proxy.
  const pacedRuns = runs.filter(
    (a) => a.movingTime >= 1200 && a.distance > 0 && a.avgSpeed && a.avgSpeed > 0
  );
  let derivedRunPace: DerivedMetric = EMPTY;
  if (pacedRuns.length > 0) {
    const fastest = Math.max(...pacedRuns.map((a) => a.avgSpeed as number)); // m/s
    const secPerKm = Math.round(1000 / fastest);
    derivedRunPace = metric(
      secPerKm,
      "derived",
      pacedRuns.length >= 5 ? "medium" : "low",
      `Estimated from your fastest sustained run (${formatPace(secPerKm)}/km) over ${pacedRuns.length} runs`
    );
  }

  // ---- Swim CSS ----------------------------------------------------------
  // Approximate critical swim speed from the best pace over a decent distance.
  const realSwims = swims.filter((a) => a.distance >= 400 && a.movingTime > 0);
  let derivedCss: DerivedMetric = EMPTY;
  if (realSwims.length > 0) {
    const best = Math.min(
      ...realSwims.map((a) => (a.movingTime / a.distance) * 100)
    );
    derivedCss = metric(
      Math.round(best),
      "derived",
      "low",
      `Estimated from your fastest swim pace (${formatPace(Math.round(best))}/100m) — a CSS test would be more accurate`
    );
  }

  // ---- Cadence -----------------------------------------------------------
  const bikeCadence = EMPTY; // Strava's summary endpoint does not expose cadence

  // ---- Weekly volume -----------------------------------------------------
  const twelveWeeksAgo = new Date(Date.now() - 84 * 24 * 60 * 60 * 1000);
  const recent = activities.filter((a) => a.startDate >= twelveWeeksAgo);
  const weeklyHours = recent.length
    ? metric(
        Math.round((recent.reduce((s, a) => s + a.movingTime, 0) / 3600 / 12) * 10) /
          10,
        "derived",
        "high",
        `Average of your last 12 weeks (${recent.length} activities)`
      )
    : EMPTY;

  // ---- Power to weight ---------------------------------------------------
  const effectiveFtp = profile?.ftpWatts ?? derivedFtp.value;
  const ftpPerKg =
    effectiveFtp && profile?.weightKg
      ? metric(
          Math.round((effectiveFtp / profile.weightKg) * 100) / 100,
          profile?.ftpWatts ? "measured" : "derived",
          profile?.ftpWatts ? "high" : "low",
          "FTP divided by your body weight"
        )
      : metric<number>(null, "missing", null, "Needs both FTP and body weight");

  return {
    hasActivityData: true,
    activityCount: activities.length,
    maxHeartRate: manualOr(profile?.maxHeartRate, derivedMaxHr),
    restingHeartRate: manualOr(profile?.restingHeartRate, EMPTY),
    weeklyHours,
    ftpWatts: manualOr(profile?.ftpWatts, derivedFtp),
    ftpPerKg,
    bikeLthr: manualOr(profile?.bikeLthr, derivedBikeLthr),
    bikeMaxHr: manualOr(
      profile?.bikeMaxHr,
      bikeMaxObserved
        ? metric(Math.round(bikeMaxObserved), "derived", "medium", "Highest HR recorded on the bike")
        : EMPTY
    ),
    bikeCadence: manualOr(profile?.bikeAvgCadence, bikeCadence),
    runThresholdPaceSec: manualOr(profile?.runThresholdPaceSec, derivedRunPace),
    runLthr: manualOr(profile?.runLthr, derivedRunLthr),
    runMaxHr: manualOr(
      profile?.runMaxHr,
      runMaxObserved
        ? metric(Math.round(runMaxObserved), "derived", "medium", "Highest HR recorded on a run")
        : EMPTY
    ),
    swimCssSecPer100: manualOr(profile?.swimCssSecPer100, derivedCss),
    equipment,
  };
}

/** A value the athlete entered always beats an estimate. */
function manualOr(
  manual: number | null | undefined,
  derived: DerivedMetric
): DerivedMetric {
  if (manual !== null && manual !== undefined) {
    return {
      ...metric(manual, "measured", "high", "Entered by you"),
      // Keep what the data shows so we can flag a disagreement later.
      dataValue: derived.value,
      dataBasis: derived.basis,
    };
  }
  return { ...derived, dataValue: derived.value, dataBasis: derived.basis };
}

function maxOf(values: Array<number | null>): number | null {
  const nums = values.filter((v): v is number => typeof v === "number" && v > 0);
  return nums.length ? Math.max(...nums) : null;
}

export function formatPace(secondsPerUnit: number): string {
  const m = Math.floor(secondsPerUnit / 60);
  const s = Math.round(secondsPerUnit % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Equipment audit — works out what hardware the athlete actually uses by
 * looking at which data fields their activities contain.
 */
export function auditEquipment(
  activities: Array<{
    discipline: string;
    avgWatts?: number | null;
    avgHeartRate?: number | null;
    distance?: number;
    isTrainer?: boolean;
    avgSpeed?: number | null;
  }>
): EquipmentAudit {
  const evidence: string[] = [];

  const withPower = activities.filter(
    (a) => typeof a.avgWatts === "number" && a.avgWatts > 0
  );
  const withHr = activities.filter(
    (a) => typeof a.avgHeartRate === "number" && a.avgHeartRate > 0
  );
  const trainerRides = activities.filter((a) => a.isTrainer);
  const outdoorWithDistance = activities.filter(
    (a) => (a.distance ?? 0) > 0 && !a.isTrainer
  );
  const swims = activities.filter(
    (a) => a.discipline === "Swim" && (a.distance ?? 0) > 0
  );

  const powerMeter = withPower.length >= 3;
  const heartRateMonitor = withHr.length >= 3;
  const smartTrainer = trainerRides.length >= 2;
  const gpsWatch = outdoorWithDistance.length >= 3;
  const swimTracking = swims.length >= 2;

  if (powerMeter)
    evidence.push(`Power data on ${withPower.length} activities → power meter or smart trainer`);
  else evidence.push("No power data found → no power meter detected");

  if (heartRateMonitor)
    evidence.push(`Heart rate on ${withHr.length} activities → HR monitor in use`);
  else evidence.push("Little or no heart-rate data → no HR monitor detected");

  if (smartTrainer)
    evidence.push(`${trainerRides.length} indoor/trainer rides → indoor trainer available`);

  if (gpsWatch)
    evidence.push(`Distance recorded on ${outdoorWithDistance.length} outdoor activities → GPS device`);

  if (swimTracking)
    evidence.push(`${swims.length} swims with distance → pool/open-water tracking device`);
  else evidence.push("No tracked swims found");

  return {
    powerMeter,
    heartRateMonitor,
    // Strava's summary feed doesn't expose cadence, so we can't claim this.
    cadenceSensor: false,
    gpsWatch,
    smartTrainer,
    swimTracking,
    evidence,
  };
}

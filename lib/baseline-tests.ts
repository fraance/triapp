/**
 * Dynamic baseline testing.
 *
 * Works out which key numbers are missing or stale, checks whether the athlete
 * actually has the equipment needed to measure them, and returns the standard
 * test protocols to drop into the opening weeks of the plan.
 *
 * A test is only ever recommended if the athlete CAN perform it — there is no
 * point prescribing an FTP test to someone without a power meter.
 */
import type { AthleteMetrics } from "./athlete-metrics";

export interface TestProtocol {
  key: string;
  discipline: "Swim" | "Bike" | "Run";
  name: string;
  /** Why this test is being suggested. */
  reason: string;
  requires: string;
  duration: string;
  instructions: string;
  /** Which profile field the result fills in. */
  fills: string;
  priority: number; // 1 = most important
}

export interface ProfileGap {
  field: string;
  label: string;
  discipline?: string;
  severity: "critical" | "useful";
  /** Can we test for it, or must the athlete simply tell us? */
  resolution: "test" | "ask";
  note: string;
}

export interface GapAnalysis {
  gaps: ProfileGap[];
  recommendedTests: TestProtocol[];
  askTheAthlete: ProfileGap[];
  readiness: number; // 0-100, how complete the profile is
}

export const TEST_PROTOCOLS: Record<string, TestProtocol> = {
  ftp20: {
    key: "ftp20",
    discipline: "Bike",
    name: "20-minute FTP test",
    reason: "You ride with a power meter but have no recent FTP on file.",
    requires: "Power meter or smart trainer",
    duration: "~60 min total",
    instructions:
      "Warm-up 20 min easy with 3x1 min fast spin-ups. Then 5 min hard effort, 10 min easy. Main set: 20 min all-out but evenly paced — the highest average power you can hold. Cool-down 10 min easy. Your FTP is 95% of the 20-minute average power.",
    fills: "ftpWatts",
    priority: 1,
  },
  cssSwim: {
    key: "cssSwim",
    discipline: "Swim",
    name: "Critical Swim Speed test (400m + 200m)",
    reason: "No swim threshold pace on file, so swim sets can't be paced properly.",
    requires: "Pool with a clock, or a swim watch",
    duration: "~45 min",
    instructions:
      "Warm-up 400m easy with drills. Swim 400m time trial at maximum sustainable effort, record the time. Rest 10 min easy. Swim 200m time trial at maximum effort, record the time. CSS pace per 100m = (400m time − 200m time) ÷ 2.",
    fills: "swimCssSecPer100",
    priority: 1,
  },
  run5k: {
    key: "run5k",
    discipline: "Run",
    name: "5 km time trial",
    reason: "No recent run threshold pace or 5k benchmark on file.",
    requires: "GPS watch and a flat route or track",
    duration: "~45 min",
    instructions:
      "Warm-up 15 min easy with 4x20 s strides. Run 5 km as fast as you can sustain, evenly paced. Cool-down 10 min easy. Use the result to set your run threshold pace and training zones.",
    fills: "runThresholdPaceSec, pb5kSec",
    priority: 1,
  },
  maxHr: {
    key: "maxHr",
    discipline: "Run",
    name: "Max heart rate field test",
    reason: "No reliable maximum heart rate on file, so HR zones are guesswork.",
    requires: "Heart-rate monitor",
    duration: "~40 min",
    instructions:
      "Only do this if you are healthy and well rested. Warm-up 15 min. Then run 3x3 min uphill, going progressively harder, with 2-3 min easy jog between. The final effort should be absolutely maximal. Your highest recorded heart rate is a good estimate of max HR.",
    fills: "maxHeartRate",
    priority: 2,
  },
  restingHr: {
    key: "restingHr",
    discipline: "Run",
    name: "Resting heart rate measurement",
    reason: "Resting HR is a simple, powerful fatigue signal and is missing.",
    requires: "Heart-rate monitor or watch",
    duration: "2 min, on waking",
    instructions:
      "On three consecutive mornings, before getting out of bed, measure your heart rate for 60 seconds. Take the average of the three readings.",
    fills: "restingHeartRate",
    priority: 3,
  },
};

/**
 * Compares what we know against what a coach needs, and decides what to test
 * versus what to simply ask.
 */
export function analyseGaps(
  metrics: AthleteMetrics,
  profile: Record<string, any> | null
): GapAnalysis {
  const gaps: ProfileGap[] = [];
  const tests: TestProtocol[] = [];
  const eq = metrics.equipment;

  const isWeak = (m: { value: number | null; source: string; confidence: string | null }) =>
    m.value === null || m.source === "derived" && m.confidence === "low";

  // --- Bike FTP ---
  if (isWeak(metrics.ftpWatts)) {
    if (eq.powerMeter || eq.smartTrainer) {
      gaps.push({
        field: "ftpWatts",
        label: "Cycling FTP",
        discipline: "Bike",
        severity: "critical",
        resolution: "test",
        note: "You have a power meter, so we can measure this properly.",
      });
      tests.push(TEST_PROTOCOLS.ftp20);
    } else {
      gaps.push({
        field: "ftpWatts",
        label: "Cycling FTP",
        discipline: "Bike",
        severity: "useful",
        resolution: "ask",
        note: "No power meter detected — bike sessions will be paced by heart rate and feel instead.",
      });
    }
  }

  // --- Swim CSS ---
  if (isWeak(metrics.swimCssSecPer100)) {
    gaps.push({
      field: "swimCssSecPer100",
      label: "Critical Swim Speed",
      discipline: "Swim",
      severity: "critical",
      resolution: "test",
      note: "Needed to set swim interval paces.",
    });
    tests.push(TEST_PROTOCOLS.cssSwim);
  }

  // --- Run threshold ---
  if (isWeak(metrics.runThresholdPaceSec)) {
    gaps.push({
      field: "runThresholdPaceSec",
      label: "Run threshold pace",
      discipline: "Run",
      severity: "critical",
      resolution: "test",
      note: "Needed to set run interval paces.",
    });
    tests.push(TEST_PROTOCOLS.run5k);
  }

  // --- Max HR ---
  if (isWeak(metrics.maxHeartRate) && eq.heartRateMonitor) {
    gaps.push({
      field: "maxHeartRate",
      label: "Maximum heart rate",
      severity: "critical",
      resolution: "test",
      note: "Your heart-rate zones depend on this.",
    });
    tests.push(TEST_PROTOCOLS.maxHr);
  }

  // --- Resting HR ---
  if (metrics.restingHeartRate.value === null && eq.heartRateMonitor) {
    gaps.push({
      field: "restingHeartRate",
      label: "Resting heart rate",
      severity: "useful",
      resolution: "test",
      note: "Useful daily fatigue signal.",
    });
    tests.push(TEST_PROTOCOLS.restingHr);
  }

  // --- Things only the athlete can tell us ---
  const askFields: Array<[string, string, "critical" | "useful", string]> = [
    ["weightKg", "Body weight", "critical", "Needed for power-to-weight and fuelling guidance."],
    ["heightCm", "Height", "useful", "Used for body composition context."],
    ["injuryHistory", "Injury history", "critical", "So the plan avoids aggravating past injuries."],
    ["weeklyHoursAvailable", "Weekly hours available", "critical", "The plan must fit your actual life."],
    ["favouriteSport", "Favourite discipline", "useful", "Helps keep training enjoyable and sustainable."],
    ["leastFavouriteSport", "Least favourite discipline", "useful", "We can protect consistency where motivation is lower."],
  ];

  for (const [field, label, severity, note] of askFields) {
    const v = profile?.[field];
    if (v === null || v === undefined || v === "") {
      gaps.push({ field, label, severity, resolution: "ask", note });
    }
  }

  const askTheAthlete = gaps.filter((g) => g.resolution === "ask");

  // Readiness score: how much of the critical picture we have.
  const criticalTotal = gaps.filter((g) => g.severity === "critical").length;
  const knownSignals = [
    metrics.maxHeartRate.value,
    metrics.ftpWatts.value,
    metrics.runThresholdPaceSec.value,
    metrics.swimCssSecPer100.value,
    profile?.weightKg,
    profile?.weeklyHoursAvailable,
    metrics.weeklyHours.value,
  ].filter((v) => v !== null && v !== undefined).length;
  const readiness = Math.round((knownSignals / 7) * 100);

  return {
    gaps,
    recommendedTests: tests.sort((a, b) => a.priority - b.priority),
    askTheAthlete,
    readiness,
  };
}

/** Renders recommended tests as an instruction block for the AI coach. */
export function formatTestsForPrompt(tests: TestProtocol[]): string {
  if (tests.length === 0) return "";

  const lines = [
    "BASELINE TESTING REQUIRED — schedule these in the first 1-2 weeks of the plan:",
  ];
  for (const t of tests) {
    lines.push(
      `- ${t.name} (${t.discipline}, ${t.duration}). Why: ${t.reason} Protocol: ${t.instructions}`
    );
  }
  lines.push(
    "Place each test on a day with adequate recovery beforehand, and treat it as that day's key session. Do not schedule two tests on consecutive days."
  );
  return lines.join("\n");
}

/**
 * The feedback loop: a completed test becomes a new threshold.
 *
 * When the athlete completes a test the engine scheduled, this reads the
 * actual activity, derives the new value, and writes it back together with a
 * fresh measurement date. That closes the cycle:
 *
 *     manual baseline → confidence decays → test scheduled → test completed
 *         → threshold updated, confidence restored → decays again
 *
 * The rule that governs everything here: **if the data cannot support a
 * trustworthy figure, return nothing.** A test that produces a confident wrong
 * number is worse than one the athlete has to repeat, because the wrong number
 * silently drives every session that follows.
 */
import { prisma } from "../prisma";
import { ThresholdKind } from "./physiology";
import { recordThreshold, proposeThreshold } from "./thresholds";

export interface TestResult {
  kind: ThresholdKind;
  value: number;
  /** How it was worked out, shown to the athlete. */
  method: string;
}

export interface TestAnalysisInput {
  kind: ThresholdKind;
  activity: {
    movingTime: number;
    distance: number;
    avgWatts: number | null;
    maxHeartRate: number | null;
    avgHeartRate: number | null;
  };
  /** Official Strava splits, where they exist. */
  bestEfforts?: Array<{ name: string; elapsedTime: number; distance: number }>;
}

/**
 * Derives a threshold from a completed test.
 *
 * Returns null whenever the evidence is insufficient — a swim with no distance,
 * an FTP test with no power, a 5 km test the athlete cut short.
 */
export function analyseTest(input: TestAnalysisInput): TestResult | null {
  const { kind, activity, bestEfforts = [] } = input;

  switch (kind) {
    case "ftp": {
      // Needs real power. Without a meter there is nothing to derive.
      if (activity.avgWatts == null || activity.avgWatts <= 0) return null;
      // The protocol is a 20-minute maximal effort; FTP is 95% of it. We only
      // hold average power for the whole ride, so this is deliberately
      // conservative rather than pretending we isolated the 20-minute block.
      const value = Math.round(activity.avgWatts * 0.95);
      if (value < 50 || value > 600) return null; // implausible — do not store
      return {
        kind,
        value,
        method: "95% of average power over the test effort",
      };
    }

    case "thresholdHr": {
      if (activity.avgHeartRate == null || activity.avgHeartRate <= 0) return null;
      const value = Math.round(activity.avgHeartRate);
      if (value < 100 || value > 220) return null;
      return { kind, value, method: "average heart rate over the test effort" };
    }

    case "maxHr": {
      if (activity.maxHeartRate == null || activity.maxHeartRate <= 0) return null;
      const value = Math.round(activity.maxHeartRate);
      if (value < 120 || value > 230) return null;
      return { kind, value, method: "highest heart rate reached during the test" };
    }

    case "runThreshold": {
      // Prefer Strava's official 5 km split — it is measured, not inferred.
      const fiveK = bestEfforts.find((e) => /^5k$/i.test(e.name.trim()));
      if (fiveK && fiveK.elapsedTime > 0) {
        const pacePerKm = fiveK.elapsedTime / 5;
        // Threshold pace sits roughly 15-20 s/km slower than 5 km race pace.
        const value = Math.round(pacePerKm + 17);
        if (value < 150 || value > 900) return null;
        return {
          kind,
          value,
          method: `5 km split of ${formatTime(fiveK.elapsedTime)}, plus 17 s/km`,
        };
      }
      // Fall back to the whole activity only if it plausibly covered 5 km.
      if (activity.distance >= 4800 && activity.movingTime > 0) {
        const pacePerKm = activity.movingTime / (activity.distance / 1000);
        const value = Math.round(pacePerKm + 17);
        if (value < 150 || value > 900) return null;
        return {
          kind,
          value,
          method: "average pace over the test, plus 17 s/km",
        };
      }
      return null;
    }

    case "css": {
      // A proper CSS test needs the 400 m and 200 m splits, which Strava's
      // summary feed does not expose for swims. Deriving CSS from average
      // pace over a whole session would be a different number wearing the
      // same name, so we decline rather than mislabel it.
      return null;
    }

    default:
      return null;
  }
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export interface FeedbackOutcome {
  sessionId: string;
  kind: ThresholdKind;
  applied: boolean;
  previous: number | null;
  value: number | null;
  method?: string;
  reason?: string;
}

/**
 * Finds completed tests that have not yet been acted on, derives the new
 * threshold, and writes it back with a fresh measurement date.
 *
 * Idempotent: once a test has updated a threshold, the recorded measurement
 * date is at or after the session date, so it is not processed twice.
 */
export async function applyCompletedTests(
  userId: string,
  opts: { now?: Date } = {}
): Promise<FeedbackOutcome[]> {
  const now = opts.now ?? new Date();

  const plan = await prisma.trainingPlan.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (!plan) return [];

  const tests = await prisma.plannedSession.findMany({
    where: {
      planId: plan.id,
      isTest: true,
      status: { in: ["completed", "substituted"] },
      scheduledDate: { lte: now },
    },
    orderBy: { scheduledDate: "asc" },
  });
  if (tests.length === 0) return [];

  const profile = await prisma.athleteProfile.findUnique({ where: { userId } });
  const { parseRecord, THRESHOLD_FIELDS } = await import("./thresholds");
  const record = parseRecord(profile?.thresholdsMeasuredAt);

  const outcomes: FeedbackOutcome[] = [];

  for (const test of tests) {
    const kind = test.testKind as ThresholdKind | null;
    if (!kind || !test.scheduledDate) continue;

    // Already acted on: the recorded measurement is at least as new as the test.
    const measured = record[kind];
    if (measured && new Date(measured.at) >= test.scheduledDate) continue;

    const dayStart = new Date(test.scheduledDate);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);

    const activity = await prisma.stravaActivity.findFirst({
      where: { userId, startDate: { gte: dayStart, lt: dayEnd } },
      orderBy: { estimatedTss: "desc" },
      include: { bestEfforts: true },
    });

    const previous =
      profile != null
        ? ((profile as never as Record<string, unknown>)[THRESHOLD_FIELDS[kind]] as
            | number
            | null)
        : null;

    if (!activity) {
      outcomes.push({
        sessionId: test.id,
        kind,
        applied: false,
        previous,
        value: null,
        reason: "the test is marked done but no matching activity was synced",
      });
      continue;
    }

    const result = analyseTest({
      kind,
      activity: {
        movingTime: activity.movingTime,
        distance: activity.distance,
        avgWatts: activity.avgWatts,
        maxHeartRate: activity.maxHeartRate,
        avgHeartRate: activity.avgHeartRate,
      },
      bestEfforts: activity.bestEfforts?.map((b) => ({
        name: b.name,
        elapsedTime: b.elapsedTime,
        distance: b.distance,
      })),
    });

    if (!result) {
      outcomes.push({
        sessionId: test.id,
        kind,
        applied: false,
        previous,
        value: null,
        reason:
          "the activity does not contain what this test needs, so no threshold " +
          "was derived — better to repeat the test than store a wrong number",
      });
      continue;
    }

    // A test the athlete deliberately performed supersedes an older manual
    // entry, but if it somehow carries weaker evidence than what is stored,
    // proposeThreshold raises it as a choice rather than imposing it.
    const proposal = await proposeThreshold(
      userId, kind, result.value, "test", activity.startDate
    );

    outcomes.push({
      sessionId: test.id,
      kind,
      applied: proposal.outcome === "applied",
      previous,
      value: result.value,
      method: result.method,
      reason: proposal.outcome === "applied" ? undefined : proposal.reason,
    });
  }

  return outcomes;
}

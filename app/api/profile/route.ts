import { NextRequest, NextResponse } from "next/server";
import { getProfile, updateProfile } from "@/lib/db";
import { recalculateAllTss } from "@/lib/strava-db";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const userId = searchParams.get("userId");

    if (!userId) {
      return NextResponse.json(
        { error: "userId is required" },
        { status: 400 }
      );
    }

    const profile = await getProfile(userId);
    if (!profile) {
      return NextResponse.json({});
    }

    return NextResponse.json({
      age: profile.age,
      gender: profile.gender,
      raceDate: profile.raceDate?.toISOString().split("T")[0],
      raceType: profile.raceType,
      pastPerformance: profile.pastPerformance,
      timezone: profile.timezone,
      maxHeartRate: profile.maxHeartRate,
      thresholdHeartRate: profile.thresholdHeartRate,
      ftpWatts: profile.ftpWatts,
      swimDifficulty: profile.swimDifficulty,
      bikeDifficulty: profile.bikeDifficulty,
      runDifficulty: profile.runDifficulty,
      heightCm: profile.heightCm,
      weightKg: profile.weightKg,
      bodyFatPct: profile.bodyFatPct,
      restingHeartRate: profile.restingHeartRate,
      hrv: profile.hrv,
      favouriteSport: profile.favouriteSport,
      leastFavouriteSport: profile.leastFavouriteSport,
      weeklyHoursAvailable: profile.weeklyHoursAvailable,
      injuryHistory: profile.injuryHistory,
      ongoingIssues: profile.ongoingIssues,
      chronicConditions: profile.chronicConditions,
      mobilityLimitations: profile.mobilityLimitations,
      tracksMenstrualCycle: profile.tracksMenstrualCycle,
      cycleLengthDays: profile.cycleLengthDays,
      lastPeriodStart: profile.lastPeriodStart?.toISOString().split("T")[0],
      swimCssSecPer100: profile.swimCssSecPer100,
      swimStrokeCount: profile.swimStrokeCount,
      swimStrokeRate: profile.swimStrokeRate,
      swimComfortOpenWater: profile.swimComfortOpenWater,
      bikeLthr: profile.bikeLthr,
      bikeMaxHr: profile.bikeMaxHr,
      bikeAvgCadence: profile.bikeAvgCadence,
      runThresholdPaceSec: profile.runThresholdPaceSec,
      runLthr: profile.runLthr,
      runMaxHr: profile.runMaxHr,
      runCadence: profile.runCadence,
      runGroundContactMs: profile.runGroundContactMs,
      runVerticalOscMm: profile.runVerticalOscMm,
      pb5kSec: profile.pb5kSec,
      pb10kSec: profile.pb10kSec,
      pbHalfSec: profile.pbHalfSec,
      pbMarathonSec: profile.pbMarathonSec,
    });
  } catch (error: any) {
    console.error("Error fetching profile:", error);
    return NextResponse.json(
      { error: error.message || "Failed to fetch profile" },
      { status: 500 }
    );
  }
}

const num = (v: any) => {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
};

/** Only map a field if the client actually sent it — prevents wiping saved settings. */
function pick<T>(body: any, key: string, transform: (v: any) => T): T | undefined {
  if (!(key in body)) return undefined;
  return transform(body[key]);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { userId } = body;

    if (!userId) {
      return NextResponse.json(
        { error: "userId is required" },
        { status: 400 }
      );
    }

    const int = (v: any) => {
      const n = num(v);
      return n === null ? null : Math.round(n);
    };

    const profile = await updateProfile(userId, {
      age: pick(body, "age", int),
      gender: pick(body, "gender", (v) => v || null),
      raceDate: pick(body, "raceDate", (v) => (v ? new Date(v) : null)),
      raceType: pick(body, "raceType", (v) => v || null),
      pastPerformance: pick(body, "pastPerformance", (v) => v || null),
      timezone: pick(body, "timezone", (v) => v || "UTC"),
      maxHeartRate: pick(body, "maxHeartRate", int),
      thresholdHeartRate: pick(body, "thresholdHeartRate", int),
      ftpWatts: pick(body, "ftpWatts", int),
      swimDifficulty: pick(body, "swimDifficulty", (v) => num(v) ?? 1),
      bikeDifficulty: pick(body, "bikeDifficulty", (v) => num(v) ?? 1),
      runDifficulty: pick(body, "runDifficulty", (v) => num(v) ?? 1),
      heightCm: pick(body, "heightCm", num),
      weightKg: pick(body, "weightKg", num),
      bodyFatPct: pick(body, "bodyFatPct", num),
      restingHeartRate: pick(body, "restingHeartRate", int),
      hrv: pick(body, "hrv", int),
      favouriteSport: pick(body, "favouriteSport", (v) => v || null),
      leastFavouriteSport: pick(body, "leastFavouriteSport", (v) => v || null),
      weeklyHoursAvailable: pick(body, "weeklyHoursAvailable", num),
      injuryHistory: pick(body, "injuryHistory", (v) => v || null),
      ongoingIssues: pick(body, "ongoingIssues", (v) => v || null),
      chronicConditions: pick(body, "chronicConditions", (v) => v || null),
      mobilityLimitations: pick(body, "mobilityLimitations", (v) => v || null),
      tracksMenstrualCycle: pick(body, "tracksMenstrualCycle", (v) => Boolean(v)),
      cycleLengthDays: pick(body, "cycleLengthDays", int),
      lastPeriodStart: pick(body, "lastPeriodStart", (v) => (v ? new Date(v) : null)),
      swimCssSecPer100: pick(body, "swimCssSecPer100", int),
      swimStrokeCount: pick(body, "swimStrokeCount", int),
      swimStrokeRate: pick(body, "swimStrokeRate", int),
      swimComfortOpenWater: pick(body, "swimComfortOpenWater", (v) => v || null),
      bikeLthr: pick(body, "bikeLthr", int),
      bikeMaxHr: pick(body, "bikeMaxHr", int),
      bikeAvgCadence: pick(body, "bikeAvgCadence", int),
      runThresholdPaceSec: pick(body, "runThresholdPaceSec", int),
      runLthr: pick(body, "runLthr", int),
      runMaxHr: pick(body, "runMaxHr", int),
      runCadence: pick(body, "runCadence", int),
      runGroundContactMs: pick(body, "runGroundContactMs", int),
      runVerticalOscMm: pick(body, "runVerticalOscMm", num),
      pb5kSec: pick(body, "pb5kSec", int),
      pb10kSec: pick(body, "pb10kSec", int),
      pbHalfSec: pick(body, "pbHalfSec", int),
      pbMarathonSec: pick(body, "pbMarathonSec", int),
    });

    // Thresholds affect how every past activity is scored — rescore them.
    let rescored = 0;
    try {
      rescored = await recalculateAllTss(userId);
    } catch (e) {
      console.error("Could not rescore activities:", e);
    }

    // A threshold the athlete types in is the strongest evidence there is, and
    // it must be dated from this moment — otherwise confidence decay has no
    // anchor and the engine falls back to prescribing by feel. Only values
    // that actually changed are re-dated: re-saving a profile must not make a
    // five-month-old FTP look freshly measured.
    let thresholdsUpdated: string[] = [];
    try {
      const { recordManualThresholds } = await import("@/lib/adaptation/thresholds");
      thresholdsUpdated = await recordManualThresholds(userId, {
        ftp: pick(body, "ftpWatts", int),
        css: pick(body, "swimCssSecPer100", int),
        runThreshold: pick(body, "runThresholdPaceSec", int),
        maxHr: pick(body, "maxHeartRate", int),
        thresholdHr: pick(body, "thresholdHeartRate", int),
      });
    } catch (e) {
      console.error("Could not record threshold measurement dates:", e);
    }

    return NextResponse.json({ ...profile, rescored, thresholdsUpdated });
  } catch (error: any) {
    console.error("Error updating profile:", error);
    return NextResponse.json(
      { error: error.message || "Failed to update profile" },
      { status: 500 }
    );
  }
}

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { thresholdConfidence, metabolicState } from "@/lib/adaptation/physiology";
import {
  getThresholdRecord,
  observationsFor,
  THRESHOLD_FIELDS,
} from "@/lib/adaptation/thresholds";
import { analyseLimiters } from "@/lib/adaptation/limiter";
import { manualProtocolFor } from "@/lib/adaptation/manual-test";
import {
  loadVectorFor,
  localISO,
  normaliseDiscipline,
} from "@/lib/adaptation/load-vector";
import type { ThresholdKind } from "@/lib/adaptation/physiology";

const KINDS: ThresholdKind[] = ["ftp", "css", "runThreshold", "maxHr", "thresholdHr"];

const LABELS: Record<ThresholdKind, string> = {
  ftp: "FTP",
  css: "Swim CSS",
  runThreshold: "Run threshold pace",
  maxHr: "Max heart rate",
  thresholdHr: "Threshold heart rate",
};

const UNITS: Record<ThresholdKind, string> = {
  ftp: "W",
  css: "sec/100m",
  runThreshold: "sec/km",
  maxHr: "bpm",
  thresholdHr: "bpm",
};

/**
 * Everything the athlete needs to check the engine's physiological reasoning:
 * how much it trusts its own numbers, what it thinks the race demands, and any
 * test it is asking for.
 */
export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId");
  if (!userId) {
    return NextResponse.json({ error: "userId is required" }, { status: 400 });
  }

  try {
    const now = new Date();

    const [profile, race, activities, record, plan] = await Promise.all([
      prisma.athleteProfile.findUnique({ where: { userId } }),
      prisma.raceProfile.findUnique({ where: { userId } }),
      prisma.stravaActivity.findMany({
        where: { userId, startDate: { gte: new Date(now.getTime() - 180 * 86400000) } },
        select: {
          startDate: true,
          discipline: true,
          name: true,
          avgSpeed: true,
          avgHeartRate: true,
          estimatedTss: true,
        },
      }),
      getThresholdRecord(userId),
      prisma.trainingPlan.findFirst({
        where: { userId },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      }),
    ]);

    // ---- Threshold confidence -------------------------------------------
    const datesFor = (d: string) =>
      activities
        .filter((a) => normaliseDiscipline(a.discipline) === d)
        .map((a) => a.startDate);
    const hrDates = activities
      .filter((a) => a.avgHeartRate != null)
      .map((a) => a.startDate);

    const evidence: Record<ThresholdKind, Date[]> = {
      ftp: datesFor("bike"),
      css: datesFor("swim"),
      runThreshold: datesFor("run"),
      maxHr: hrDates,
      thresholdHr: hrDates,
    };

    const thresholds = KINDS.map((kind) => {
      const value = profile
        ? ((profile as never as Record<string, unknown>)[THRESHOLD_FIELDS[kind]] as
            | number
            | null)
        : null;
      const c = thresholdConfidence(
        kind,
        value,
        observationsFor(kind, record, evidence[kind]),
        now
      );
      return {
        kind,
        label: LABELS[kind],
        unit: UNITS[kind],
        value: c.value,
        confidence: c.confidence,
        useRpe: c.useRpe,
        needsTest: c.needsTest,
        basis: c.basis,
        measuredAt: record[kind]?.at ?? null,
        source: record[kind]?.source ?? null,
        /** How they would capture this themselves if they had to. */
        manualProtocol: manualProtocolFor(kind),
      };
    });

    // ---- Tests the engine has scheduled ---------------------------------
    const tests = plan
      ? await prisma.plannedSession.findMany({
          where: { planId: plan.id, isTest: true, status: { in: ["planned", "adapted"] } },
          orderBy: { scheduledDate: "asc" },
          select: {
            id: true,
            scheduledDate: true,
            discipline: true,
            testKind: true,
            testMode: true,
            duration: true,
            instructions: true,
          },
        })
      : [];

    // ---- Limiter analysis -----------------------------------------------
    const speeds = activities
      .filter((a) => normaliseDiscipline(a.discipline) === "bike" && a.avgSpeed)
      .map((a) => a.avgSpeed!)
      .sort((a, b) => a - b);
    const limiters = analyseLimiters(
      {
        swimCssSecPer100: profile?.swimCssSecPer100 ?? null,
        runThresholdPaceSec: profile?.runThresholdPaceSec ?? null,
        bikeSpeedMs: speeds.length ? speeds[Math.floor(speeds.length / 2)] : null,
      },
      {
        raceType: race?.distanceType ?? profile?.raceType ?? null,
        swimEnvironment: race?.swimEnvironment ?? null,
        wetsuitLikely: race?.wetsuitLikely ?? null,
        bikeElevationGainM: race?.bikeElevationGainM ?? null,
        runElevationGainM: race?.runElevationGainM ?? null,
        runSurface: race?.runSurface ?? null,
      }
    );

    // ---- Metabolic state -------------------------------------------------
    const loads = activities.map((a) => ({
      date: localISO(a.startDate),
      load: loadVectorFor({
        discipline: a.discipline,
        tss: a.estimatedTss,
        type: a.name,
      }),
    }));
    const metabolic = metabolicState(loads, now);

    return NextResponse.json({
      thresholds,
      tests: tests.map((t) => ({
        ...t,
        date: t.scheduledDate ? localISO(t.scheduledDate) : null,
        manualProtocol:
          t.testMode === "manual" && t.testKind
            ? manualProtocolFor(t.testKind as ThresholdKind)
            : null,
      })),
      limiters,
      metabolic,
    });
  } catch (error: any) {
    console.error("Failed to build fitness view:", error);
    return NextResponse.json(
      { error: error.message || "Failed to load" },
      { status: 500 }
    );
  }
}

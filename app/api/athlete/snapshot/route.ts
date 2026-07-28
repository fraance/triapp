import { NextRequest, NextResponse } from "next/server";
import { getAthleteSnapshot } from "@/lib/athlete-context";
import { detectPersonalBests, formatTime } from "@/lib/personal-bests";

/**
 * What the system knows about the athlete: derived metrics, detected
 * equipment, remaining gaps and recommended baseline tests.
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const userId = searchParams.get("userId");
    if (!userId) {
      return NextResponse.json({ error: "userId is required" }, { status: 400 });
    }

    const snapshot = await getAthleteSnapshot(userId);
    const pbs = await detectPersonalBests(userId).catch(() => []);

    return NextResponse.json({
      metrics: snapshot.metrics,
      equipment: snapshot.metrics.equipment,
      gaps: snapshot.gaps.gaps,
      askTheAthlete: snapshot.gaps.askTheAthlete,
      recommendedTests: snapshot.gaps.recommendedTests,
      readiness: snapshot.gaps.readiness,
      personalBests: pbs.map((p) => ({ ...p, time: formatTime(p.seconds) })),
      hasRaceProfile: Boolean(snapshot.race),
      raceConfirmed: snapshot.race?.confirmed ?? false,
    });
  } catch (error: any) {
    console.error("Athlete snapshot error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to build athlete snapshot" },
      { status: 500 }
    );
  }
}

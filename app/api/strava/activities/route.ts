import { NextRequest, NextResponse } from "next/server";
import { getActivities } from "@/lib/strava-db";

/** Returns the activities we have stored for this user. */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const userId = searchParams.get("userId");
    const limit = parseInt(searchParams.get("limit") || "50");

    if (!userId) {
      return NextResponse.json({ error: "userId is required" }, { status: 400 });
    }

    const activities = await getActivities(userId, limit);

    return NextResponse.json({
      count: activities.length,
      activities: activities.map((a) => ({
        id: a.id,
        name: a.name,
        discipline: a.discipline,
        sportType: a.sportType,
        date: a.startDate.toISOString(),
        minutes: Math.round(a.movingTime / 60),
        distanceKm: Math.round((a.distance / 1000) * 100) / 100,
        elevationGain: a.elevationGain,
        avgHeartRate: a.avgHeartRate,
        maxHeartRate: a.maxHeartRate,
        avgWatts: a.avgWatts,
        estimatedTss: a.estimatedTss,
        isTrainer: a.isTrainer,
      })),
    });
  } catch (error: any) {
    console.error("Error fetching stored activities:", error);
    return NextResponse.json(
      { error: error.message || "Failed to fetch activities" },
      { status: 500 }
    );
  }
}

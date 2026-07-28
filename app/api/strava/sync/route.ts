import { NextRequest, NextResponse } from "next/server";
import { syncStravaActivities } from "@/lib/strava-db";

/** Pulls the latest activities from Strava into our database. */
export async function POST(req: NextRequest) {
  try {
    const { userId } = await req.json();

    if (!userId) {
      return NextResponse.json({ error: "userId is required" }, { status: 400 });
    }

    const result = await syncStravaActivities(userId);
    return NextResponse.json(result);
  } catch (error: any) {
    console.error("Strava sync error:", error);
    const notConnected = /not connected/i.test(error.message || "");
    return NextResponse.json(
      { error: error.message || "Failed to sync Strava activities" },
      { status: notConnected ? 401 : 500 }
    );
  }
}

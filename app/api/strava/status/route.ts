import { NextRequest, NextResponse } from "next/server";
import { isStravaConfigured } from "@/lib/strava";
import {
  getStravaToken,
  getActivityCount,
  buildTrainingHistory,
  disconnectStrava,
} from "@/lib/strava-db";

/** Reports whether the user has Strava connected and what we've imported. */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const userId = searchParams.get("userId");

    if (!userId) {
      return NextResponse.json({ error: "userId is required" }, { status: 400 });
    }

    const token = await getStravaToken(userId);
    const activityCount = await getActivityCount(userId);
    const history = await buildTrainingHistory(userId);

    return NextResponse.json({
      configured: isStravaConfigured(),
      connected: Boolean(token),
      athleteName: token?.athleteName ?? null,
      lastSyncedAt: token?.lastSyncedAt ?? null,
      lastSyncError: token?.lastSyncError ?? null,
      activityCount,
      history,
    });
  } catch (error: any) {
    console.error("Strava status error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to read Strava status" },
      { status: 500 }
    );
  }
}

/** Disconnects Strava for the user (activities are kept). */
export async function DELETE(req: NextRequest) {
  try {
    const { userId } = await req.json();
    if (!userId) {
      return NextResponse.json({ error: "userId is required" }, { status: 400 });
    }
    await disconnectStrava(userId);
    return NextResponse.json({ disconnected: true });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || "Failed to disconnect" },
      { status: 500 }
    );
  }
}

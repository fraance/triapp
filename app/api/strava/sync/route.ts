import { NextRequest, NextResponse } from "next/server";
import { syncOneUserNow } from "@/lib/scheduler";

/**
 * Pulls the latest activities from Strava and immediately reconciles (and,
 * where warranted, adapts) the plan against them.
 *
 * This used to only sync raw activities — the athlete could tap "Sync",
 * see their ride land on the Strava tab, then go to the plan and still find
 * yesterday's session sitting there unreconciled for hours, until the
 * background job next ran. The manual button must show the truth immediately,
 * not eventually.
 */
export async function POST(req: NextRequest) {
  try {
    const { userId } = await req.json();

    if (!userId) {
      return NextResponse.json({ error: "userId is required" }, { status: 400 });
    }

    const result = await syncOneUserNow(userId, { trigger: "manual_sync" });
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

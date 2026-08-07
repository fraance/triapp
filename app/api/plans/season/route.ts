import { NextRequest, NextResponse } from "next/server";
import { getSeasonView } from "@/lib/db";
import { reconcileIfStale } from "@/lib/adaptation/reconcile-if-stale";

/** Returns every week from now to race day, detailed or outline-only. */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const userId = searchParams.get("userId");

    if (!userId) {
      return NextResponse.json({ error: "userId is required" }, { status: 400 });
    }

    // The calendar must match Strava. If anything was synced since the plan
    // last absorbed an activity, reconcile it into the plan before building
    // the view — otherwise the calendar silently lags the athlete's rides.
    await reconcileIfStale(userId);

    const season = await getSeasonView(userId);
    return NextResponse.json(season);
  } catch (error: any) {
    console.error("Error building season view:", error);
    return NextResponse.json(
      { error: error.message || "Failed to load season" },
      { status: 500 }
    );
  }
}

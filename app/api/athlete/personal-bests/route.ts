import { NextRequest, NextResponse } from "next/server";
import {
  detectPersonalBests,
  enrichBestEfforts,
  applyPersonalBestsToProfile,
  formatTime,
} from "@/lib/personal-bests";

export const maxDuration = 300;

/** Personal bests detected from the athlete's Strava history. */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const userId = searchParams.get("userId");
    if (!userId) {
      return NextResponse.json({ error: "userId is required" }, { status: 400 });
    }

    const pbs = await detectPersonalBests(userId);
    return NextResponse.json({
      personalBests: pbs.map((p) => ({ ...p, time: formatTime(p.seconds) })),
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || "Failed to detect personal bests" },
      { status: 500 }
    );
  }
}

/**
 * Pulls Strava's official best-effort splits for runs we haven't detailed yet,
 * then writes the resulting PBs onto the athlete profile.
 */
export async function POST(req: NextRequest) {
  try {
    const { userId, limit } = await req.json();
    if (!userId) {
      return NextResponse.json({ error: "userId is required" }, { status: 400 });
    }

    let enrichment = { processed: 0, effortsStored: 0, remaining: 0 };
    let warning: string | null = null;
    try {
      enrichment = await enrichBestEfforts(userId, { limit: limit ?? 25 });
    } catch (error: any) {
      warning = error?.message || "Could not fetch detailed activities";
    }

    const applied = await applyPersonalBestsToProfile(userId);
    const pbs = await detectPersonalBests(userId);

    return NextResponse.json({
      ...enrichment,
      warning,
      updated: applied.updated,
      personalBests: pbs.map((p) => ({ ...p, time: formatTime(p.seconds) })),
    });
  } catch (error: any) {
    console.error("Personal best sync error:", error);
    const notConnected = /not connected/i.test(error?.message || "");
    return NextResponse.json(
      { error: error.message || "Failed to sync personal bests" },
      { status: notConnected ? 401 : 500 }
    );
  }
}

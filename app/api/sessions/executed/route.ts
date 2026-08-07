import { NextRequest, NextResponse } from "next/server";
import { updateExecutedSession, sessionBelongsToUser } from "@/lib/db";

/**
 * Lets the athlete correct what a completed session actually was — e.g. "did
 * 3x3 instead of the prescribed 6x3" — so the adaptation engine reasons about
 * what really happened, not Strava's best guess or the original prescription.
 */
export async function POST(req: NextRequest) {
  try {
    const { userId, sessionId, actualTss, athleteNote } = await req.json();

    if (!userId || !sessionId) {
      return NextResponse.json(
        { error: "userId and sessionId are required" },
        { status: 400 }
      );
    }
    if (actualTss === undefined && athleteNote === undefined) {
      return NextResponse.json(
        { error: "Provide actualTss and/or athleteNote to update" },
        { status: 400 }
      );
    }

    const owns = await sessionBelongsToUser(sessionId, userId);
    if (!owns) {
      return NextResponse.json(
        { error: "Session not found for this user" },
        { status: 403 }
      );
    }

    const updated = await updateExecutedSession(sessionId, {
      actualTss: typeof actualTss === "number" ? actualTss : undefined,
      athleteNote: typeof athleteNote === "string" ? athleteNote : undefined,
    });

    // The rest of the plan should react to the corrected reality (a session
    // that cost far less than Strava/the plan assumed changes the acute load
    // the next few days are built against). Never let this block the save.
    let adapted = false;
    try {
      const { adaptPlanForUser } = await import("@/lib/adaptation/engine");
      const outcome = await adaptPlanForUser(userId, {
        trigger: "athlete_correction",
      });
      adapted = outcome.outcome === "applied";
    } catch (e) {
      console.error("Re-adapting after an executed-session edit failed:", e);
    }

    return NextResponse.json({
      id: updated.id,
      actualTss: updated.actualTss,
      athleteNote: updated.athleteNote,
      adapted,
    });
  } catch (error: any) {
    console.error("Error updating executed session:", error);
    return NextResponse.json(
      { error: error.message || "Failed to update session" },
      { status: 400 }
    );
  }
}
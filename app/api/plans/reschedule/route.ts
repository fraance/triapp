import { NextRequest, NextResponse } from "next/server";
import { applyMoves, SessionMove } from "@/lib/reschedule";

/**
 * Commits a batch of manual session moves.
 *
 * The calendar holds the athlete's draft client-side and sends the whole set
 * at once, so this is all-or-nothing: if any single move is illegal, nothing
 * is written and the draft survives for them to fix. Partially applying a
 * rearrangement would leave a plan nobody chose.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { userId, moves } = body as {
      userId?: string;
      moves?: SessionMove[];
    };

    if (!userId) {
      return NextResponse.json({ error: "userId is required" }, { status: 400 });
    }

    if (!Array.isArray(moves)) {
      return NextResponse.json(
        { error: "moves must be an array" },
        { status: 400 }
      );
    }

    const malformed = moves.find(
      (m) => !m || typeof m.sessionId !== "string" || typeof m.toDate !== "string"
    );
    if (malformed) {
      return NextResponse.json(
        { error: "each move needs a sessionId and a toDate" },
        { status: 400 }
      );
    }

    const result = await applyMoves(userId, moves);

    // A rejected batch is the athlete's plan disagreeing with the rules, not a
    // server fault. 409 so the client can show the reasons against the cards.
    if (!result.applied && result.rejected.length > 0) {
      return NextResponse.json(result, { status: 409 });
    }

    return NextResponse.json(result);
  } catch (error: any) {
    console.error("Error rescheduling sessions:", error);
    return NextResponse.json(
      { error: error.message || "Failed to reschedule" },
      { status: 500 }
    );
  }
}

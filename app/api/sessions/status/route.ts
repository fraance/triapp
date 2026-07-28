import { NextRequest, NextResponse } from "next/server";
import { updateSessionStatus, sessionBelongsToUser } from "@/lib/db";

const ALLOWED = ["planned", "completed", "skipped"];

export async function POST(req: NextRequest) {
  try {
    const { userId, sessionId, status, actualTss } = await req.json();

    if (!userId || !sessionId || !status) {
      return NextResponse.json(
        { error: "userId, sessionId and status are required" },
        { status: 400 }
      );
    }

    if (!ALLOWED.includes(status)) {
      return NextResponse.json(
        { error: `status must be one of: ${ALLOWED.join(", ")}` },
        { status: 400 }
      );
    }

    // Make sure this session actually belongs to the requesting user.
    const owns = await sessionBelongsToUser(sessionId, userId);
    if (!owns) {
      return NextResponse.json(
        { error: "Session not found for this user" },
        { status: 403 }
      );
    }

    const updated = await updateSessionStatus(
      sessionId,
      status,
      typeof actualTss === "number" ? actualTss : undefined,
      status === "completed" ? new Date() : undefined
    );

    return NextResponse.json({
      id: updated.id,
      status: updated.status,
      actualTss: updated.actualTss,
      completedAt: updated.completedAt,
    });
  } catch (error: any) {
    console.error("Error updating session status:", error);
    return NextResponse.json(
      { error: error.message || "Failed to update session" },
      { status: 500 }
    );
  }
}

import { NextRequest, NextResponse } from "next/server";
import { updateSessionStatus, sessionBelongsToUser } from "@/lib/db";
import { adaptPlanForUser } from "@/lib/adaptation/engine";

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

    // A status change is a real signal — react to it. A skip above everything
    // else must be given the chance to requeue important work elsewhere.
    let adaptation: Awaited<ReturnType<typeof adaptPlanForUser>> | null = null;
    try {
      if (status === "skipped" || status === "completed") {
        adaptation = await adaptPlanForUser(userId, {
          trigger: `session_${status}`,
        });
      }
    } catch (e) {
      console.error("Could not run adaptation after status change:", e);
    }

    return NextResponse.json({
      id: updated.id,
      status: updated.status,
      actualTss: updated.actualTss,
      completedAt: updated.completedAt,
      adaptation: adaptation
        ? { outcome: adaptation.outcome, reason: adaptation.reason }
        : null,
    });
  } catch (error: any) {
    console.error("Error updating session status:", error);
    return NextResponse.json(
      { error: error.message || "Failed to update session" },
      { status: 500 }
    );
  }
}

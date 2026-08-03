import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getPendingDecisions, answerDecision } from "@/lib/adaptation/decisions";

export const maxDuration = 300;

/** Judgement calls waiting on the athlete. */
export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId");
  if (!userId) {
    return NextResponse.json({ error: "userId is required" }, { status: 400 });
  }
  try {
    return NextResponse.json({ decisions: await getPendingDecisions(userId) });
  } catch (error: any) {
    console.error("Failed to load decisions:", error);
    return NextResponse.json({ error: "Failed to load" }, { status: 500 });
  }
}

/**
 * Records an answer and makes it take effect.
 *
 * `rebuild: true` regenerates the plan in the same request. That is slow —
 * the model writes every remaining week — but doing it here means the athlete
 * sees the result of their choice rather than being told to go and press
 * something else.
 */
export async function POST(req: NextRequest) {
  try {
    const { userId, kind, answer, rebuild } = await req.json();
    if (!userId || !kind || !answer) {
      return NextResponse.json(
        { error: "userId, kind and answer are required" },
        { status: 400 }
      );
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return NextResponse.json({ error: "unknown user" }, { status: 404 });

    const result = await answerDecision(userId, kind, answer);
    if (!result.applied) {
      return NextResponse.json({ error: result.message }, { status: 400 });
    }

    let rebuilt = false;
    if (result.requiresRebuild && rebuild !== false) {
      try {
        const { rebuildPlan } = await import("@/lib/adaptation/rebuild");
        await rebuildPlan(userId);
        rebuilt = true;
      } catch (e: any) {
        console.error("Rebuild failed:", e);
        return NextResponse.json({
          message: result.message,
          rebuilt: false,
          warning:
            "Your choice was saved, but rebuilding the plan failed. Try again " +
            "from your plan page.",
        });
      }
    }

    return NextResponse.json({
      message: result.message,
      requiresRebuild: result.requiresRebuild ?? false,
      rebuilt,
    });
  } catch (error: any) {
    console.error("Failed to record the decision:", error);
    return NextResponse.json(
      { error: error.message || "Could not record that" },
      { status: 500 }
    );
  }
}

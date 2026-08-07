import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { handleAthleteMessage } from "@/lib/adaptation/coach-chat";

export const maxDuration = 120;

/** The last few things the athlete told the coach, and what it did. */
export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId");
  if (!userId) {
    return NextResponse.json({ error: "userId is required" }, { status: 400 });
  }
  const rows = await prisma.athleteReport.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { id: true, rawText: true, reply: true, createdAt: true },
  });
  return NextResponse.json({ messages: rows.reverse() });
}

/**
 * Tell the coach something. It parses, decides, re-plans and replies.
 *
 * Rate-limited: re-planning is the expensive part and the PRD caps manual
 * regenerations. Reporting the same thing ten times in a minute should not
 * reshape the week ten times.
 */
export async function POST(req: NextRequest) {
  try {
    const { userId, message, dryRun } = await req.json();

    if (!userId || typeof message !== "string" || !message.trim()) {
      return NextResponse.json(
        { error: "userId and a message are required" },
        { status: 400 }
      );
    }
    if (message.length > 2000) {
      return NextResponse.json(
        { error: "That message is too long — keep it under 2000 characters." },
        { status: 400 }
      );
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return NextResponse.json({ error: "unknown user" }, { status: 404 });

    const recent = await prisma.athleteReport.count({
      where: { userId, createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) } },
    });
    if (recent >= 12) {
      return NextResponse.json(
        {
          error:
            "That's a lot of updates in an hour. Give it a little while — the " +
            "plan has already taken them into account.",
        },
        { status: 429 }
      );
    }

    const result = await handleAthleteMessage(userId, message, { dryRun });

    return NextResponse.json({
      understood: result.understood,
      reply: result.reply,
      parsed: result.parsed,
      risk: result.risk
        ? {
            decision: result.risk.decision,
            injuryRisk: result.risk.injuryRisk,
            fitnessGain: result.risk.fitnessGain,
            reasons: result.risk.reasons,
          }
        : null,
      opportunity: result.opportunity
        ? {
            blocked: result.opportunity.blocked,
            focus: result.opportunity.focus,
            redirectedLoad: result.opportunity.redirectedLoad,
            deferredLoad: result.opportunity.deferredLoad,
          }
        : null,
      changes: result.outcome?.changes ?? [],
      outcome: result.outcome?.outcome ?? null,
      scheduleChange: result.scheduleOutcome.attempted
        ? {
            kind: result.scheduleOutcome.kind,
            applied: result.scheduleOutcome.changes.length > 0,
            changes: result.scheduleOutcome.changes,
            rejectedReason: result.scheduleOutcome.rejectedReason,
          }
        : null,
    });
  } catch (error: any) {
    console.error("Coach chat failed:", error);
    return NextResponse.json(
      { error: error.message || "Could not process that" },
      { status: 500 }
    );
  }
}

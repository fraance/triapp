import { NextRequest, NextResponse } from "next/server";
import { recentAdaptations } from "@/lib/adaptation/engine";

/**
 * The athlete-facing change log: what the coach changed, and why.
 *
 * This exists because a plan that silently reshapes itself is impossible to
 * trust. Every applied adaptation is readable here.
 */
export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId");
  if (!userId) {
    return NextResponse.json({ error: "userId is required" }, { status: 400 });
  }

  const limit = Number(req.nextUrl.searchParams.get("limit") ?? 10);

  try {
    const rows = await recentAdaptations(userId, Math.min(50, Math.max(1, limit)));
    return NextResponse.json({
      adaptations: rows.map((r) => ({
        id: r.id,
        trigger: r.trigger,
        explanation: r.explanation,
        changes: (r.diff as any)?.changes ?? [],
        at: r.createdAt,
      })),
    });
  } catch (error: any) {
    console.error("Failed to load adaptations:", error);
    return NextResponse.json(
      { error: error.message || "Failed to load adaptations" },
      { status: 500 }
    );
  }
}

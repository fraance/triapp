import { NextRequest, NextResponse } from "next/server";
import { getPendingSuggestions, resolveSuggestion } from "@/lib/prefill";

/** Differences waiting for the athlete's decision. */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const userId = searchParams.get("userId");
    if (!userId) {
      return NextResponse.json({ error: "userId is required" }, { status: 400 });
    }

    const suggestions = await getPendingSuggestions(userId);
    return NextResponse.json({
      suggestions: suggestions.map((s) => ({
        field: s.field,
        label: s.label,
        currentDisplay: s.currentDisplay,
        suggestedDisplay: s.suggestedDisplay,
        origin: s.origin,
      })),
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || "Failed to load suggestions" },
      { status: 500 }
    );
  }
}

/** Records the athlete's choice: keep theirs, or use ours. */
export async function POST(req: NextRequest) {
  try {
    const { userId, field, decision } = await req.json();
    if (!userId || !field || !["accept", "dismiss"].includes(decision)) {
      return NextResponse.json(
        { error: "userId, field and decision (accept|dismiss) are required" },
        { status: 400 }
      );
    }

    const result = await resolveSuggestion(userId, field, decision);
    if (!result.resolved) {
      return NextResponse.json({ error: "Suggestion not found" }, { status: 404 });
    }
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || "Failed to resolve suggestion" },
      { status: 500 }
    );
  }
}

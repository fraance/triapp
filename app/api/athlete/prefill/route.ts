import { NextRequest, NextResponse } from "next/server";
import { prefillAthleteProfile } from "@/lib/prefill";

export const maxDuration = 120;

/**
 * Fills every blank profile field we can from the data we already hold.
 * Never overwrites anything the athlete entered themselves.
 */
export async function POST(req: NextRequest) {
  try {
    const { userId } = await req.json();
    if (!userId) {
      return NextResponse.json({ error: "userId is required" }, { status: 400 });
    }

    const result = await prefillAthleteProfile(userId);
    return NextResponse.json(result);
  } catch (error: any) {
    console.error("Prefill error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to prefill profile" },
      { status: 500 }
    );
  }
}

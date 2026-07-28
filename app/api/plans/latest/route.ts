import { NextRequest, NextResponse } from "next/server";
import { getUserLatestPlanAsWeeks } from "@/lib/db";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const userId = searchParams.get("userId");

    if (!userId) {
      return NextResponse.json(
        { error: "userId is required" },
        { status: 400 }
      );
    }

    const weeks = await getUserLatestPlanAsWeeks(userId);
    // Returns null when the user has no plan yet, or the weeks array.
    return NextResponse.json(weeks);
  } catch (error: any) {
    console.error("Error fetching plan:", error);
    return NextResponse.json(
      { error: error.message || "Failed to fetch plan" },
      { status: 500 }
    );
  }
}

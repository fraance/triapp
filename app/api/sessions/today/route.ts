import { NextRequest, NextResponse } from "next/server";
import { getTodayView } from "@/lib/db";
import { reconcileIfStale } from "@/lib/adaptation/reconcile-if-stale";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const userId = searchParams.get("userId");
    // Optional ?date=YYYY-MM-DD lets us preview another day (and makes testing easy).
    const dateParam = searchParams.get("date");

    if (!userId) {
      return NextResponse.json(
        { error: "userId is required" },
        { status: 400 }
      );
    }

    let reference = new Date();
    if (dateParam) {
      const [y, m, d] = dateParam.split("-").map(Number);
      if (y && m && d) reference = new Date(y, m - 1, d);
    }

    await reconcileIfStale(userId);
    const view = await getTodayView(userId, reference);
    return NextResponse.json(view);
  } catch (error: any) {
    console.error("Error building today view:", error);
    return NextResponse.json(
      { error: error.message || "Failed to load today's session" },
      { status: 500 }
    );
  }
}

import { NextRequest, NextResponse } from "next/server";
import {
  getAvailability,
  saveAvailability,
  getTrainingBudget,
} from "@/lib/availability";

/** The athlete's time budget, their physical capacity, and the binding limit. */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const userId = searchParams.get("userId");
    if (!userId) {
      return NextResponse.json({ error: "userId is required" }, { status: 400 });
    }

    const budget = await getTrainingBudget(userId);
    return NextResponse.json(budget);
  } catch (error: any) {
    console.error("Availability error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to load availability" },
      { status: 500 }
    );
  }
}

/** Saves how many hours the athlete has on each day. */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { userId } = body;
    if (!userId) {
      return NextResponse.json({ error: "userId is required" }, { status: 400 });
    }

    await saveAvailability(userId, body);
    const budget = await getTrainingBudget(userId);
    return NextResponse.json(budget);
  } catch (error: any) {
    console.error("Save availability error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to save availability" },
      { status: 500 }
    );
  }
}

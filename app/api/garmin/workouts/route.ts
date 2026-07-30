import { NextResponse } from "next/server";

/**
 * Garmin is not available yet — our developer application is still under
 * review. This endpoint previously returned fabricated workouts, which risked
 * fake data being mistaken for real training. It now reports the truth.
 */
export async function GET() {
  return NextResponse.json(
    {
      available: false,
      connected: false,
      workouts: [],
      reason:
        "Garmin integration is pending approval of our developer application.",
    },
    { status: 503 }
  );
}

import { NextResponse } from "next/server";

/** Garmin sync is unavailable until our API access is approved. */
export async function POST() {
  return NextResponse.json(
    {
      available: false,
      reason:
        "Garmin integration is pending approval of our developer application.",
    },
    { status: 503 }
  );
}

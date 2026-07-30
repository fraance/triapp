import { NextResponse } from "next/server";

/**
 * Calendar integration has not been built. This previously returned invented
 * events; it now reports that nothing is connected.
 */
export async function GET() {
  return NextResponse.json(
    {
      available: false,
      connected: false,
      events: [],
      reason: "Calendar sync has not been built yet.",
    },
    { status: 503 }
  );
}

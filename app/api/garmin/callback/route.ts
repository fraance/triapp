import { NextResponse } from "next/server";

/**
 * Garmin OAuth callback. Not usable yet: we have no approved Garmin
 * credentials, so no account can be linked.
 */
export async function GET() {
  return NextResponse.json(
    {
      available: false,
      reason:
        "Garmin integration is pending approval of our developer application.",
    },
    { status: 503 }
  );
}

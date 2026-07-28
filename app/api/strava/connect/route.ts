import { NextRequest, NextResponse } from "next/server";
import { buildAuthorizeUrl, isStravaConfigured } from "@/lib/strava";

/**
 * Starts the Strava OAuth flow. We pass the userId through the `state`
 * parameter so the callback knows which account to attach the tokens to.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const userId = searchParams.get("userId");

  if (!userId) {
    return NextResponse.json({ error: "userId is required" }, { status: 400 });
  }

  if (!isStravaConfigured()) {
    return NextResponse.json(
      {
        error:
          "Strava is not configured. Add STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET to .env.local and restart the server.",
      },
      { status: 500 }
    );
  }

  return NextResponse.redirect(buildAuthorizeUrl(userId));
}

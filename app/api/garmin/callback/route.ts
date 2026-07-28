import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const code = searchParams.get("code");
    const state = searchParams.get("state");

    if (!code || !state) {
      // For MVP with mock data, we don't need real OAuth flow
      // Just set a fake Garmin token and redirect to workouts page
      const response = NextResponse.redirect(new URL("/workouts", req.url));
      response.cookies.set("garmin_token", "mock_garmin_token_12345", {
        maxAge: 60 * 60 * 24 * 365, // 1 year
      });
      return response;
    }

    // In production with real Garmin credentials:
    // 1. Exchange code for token
    // 2. Store token securely
    // 3. Fetch user workouts from Garmin API
    // For now, just set a mock token
    const response = NextResponse.redirect(new URL("/workouts", req.url));
    response.cookies.set("garmin_token", "mock_garmin_token_12345", {
      maxAge: 60 * 60 * 24 * 365,
    });
    return response;
  } catch (error: any) {
    console.error("Garmin callback error:", error);
    return NextResponse.redirect(
      new URL("/profile?error=garmin_auth_failed", req.url)
    );
  }
}

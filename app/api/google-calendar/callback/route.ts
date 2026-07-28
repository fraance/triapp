import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const code = searchParams.get("code");
    const state = searchParams.get("state");

    if (!code) {
      // For MVP with mock data, just set a fake token and redirect
      const response = NextResponse.redirect(new URL("/calendar", req.url));
      response.cookies.set("google_calendar_token", "mock_google_token_12345", {
        maxAge: 60 * 60 * 24 * 365, // 1 year
      });
      return response;
    }

    // In production with real Google credentials:
    // 1. Exchange code for token using GOOGLE_CLIENT_SECRET
    // 2. Store token securely
    // 3. Fetch user's calendar events
    // For now, just set a mock token
    const response = NextResponse.redirect(new URL("/calendar", req.url));
    response.cookies.set("google_calendar_token", "mock_google_token_12345", {
      maxAge: 60 * 60 * 24 * 365,
    });
    return response;
  } catch (error: any) {
    console.error("Google Calendar callback error:", error);
    return NextResponse.redirect(
      new URL("/profile?error=google_calendar_auth_failed", req.url)
    );
  }
}

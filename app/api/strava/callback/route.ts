import { NextRequest, NextResponse } from "next/server";
import { exchangeCodeForToken } from "@/lib/strava";
import { saveStravaToken, syncStravaActivities } from "@/lib/strava-db";
import { reconcileAndAdaptUser } from "@/lib/scheduler";

/**
 * Strava redirects here after the athlete approves access.
 * We exchange the code for tokens, store them against the user, then do an
 * initial import of their recent activities.
 */
export async function GET(req: NextRequest) {
  const { searchParams, origin } = new URL(req.url);
  const code = searchParams.get("code");
  const userId = searchParams.get("state"); // we passed userId as state
  const error = searchParams.get("error");

  if (error) {
    return NextResponse.redirect(
      `${origin}/strava?error=${encodeURIComponent(error)}`
    );
  }

  if (!code || !userId) {
    return NextResponse.redirect(`${origin}/strava?error=missing_code`);
  }

  try {
    const token = await exchangeCodeForToken(code);

    const athleteName = token.athlete
      ? [token.athlete.firstname, token.athlete.lastname]
          .filter(Boolean)
          .join(" ")
      : undefined;

    await saveStravaToken(userId, {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: new Date(token.expires_at * 1000),
      athleteId: token.athlete ? String(token.athlete.id) : undefined,
      athleteName,
      scope: token.scope,
    });

    // Initial import of recent history so there is data to work with straight away.
    let imported = 0;
    try {
      const result = await syncStravaActivities(userId);
      imported = result.added;
    } catch (syncError) {
      console.error("Initial Strava sync failed:", syncError);
    }

    // A reconnect can happen with an existing plan already in progress —
    // bring it in line with whatever history just arrived rather than
    // leaving it stale until the next background sync.
    try {
      await reconcileAndAdaptUser(userId, "strava_connect");
    } catch (reconcileError) {
      console.error("Reconcile after connect failed:", reconcileError);
    }

    // Prefill everything we can now that we have their data.
    let prefilled = 0;
    try {
      const { prefillAthleteProfile } = await import("@/lib/prefill");
      const result = await prefillAthleteProfile(userId);
      prefilled = result.applied.length;
    } catch (prefillError) {
      console.error("Prefill after connect failed:", prefillError);
    }

    return NextResponse.redirect(
      `${origin}/strava?connected=1&imported=${imported}&prefilled=${prefilled}`
    );
  } catch (err: any) {
    console.error("Strava callback error:", err);
    return NextResponse.redirect(
      `${origin}/strava?error=${encodeURIComponent(err.message || "callback_failed")}`
    );
  }
}

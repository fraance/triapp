import { NextRequest, NextResponse } from "next/server";
import { syncAllConnectedUsers } from "@/lib/strava-db";

export const maxDuration = 300;

/**
 * Daily background job: pulls new Strava activities for every connected athlete.
 *
 * Protected by CRON_SECRET so it cannot be triggered by anyone who stumbles
 * across the URL. Send it either as `Authorization: Bearer <secret>` (what
 * hosted schedulers use) or `?secret=<secret>`.
 */
function isAuthorised(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  // If no secret is configured we only allow local requests.
  if (!expected) {
    const host = req.headers.get("host") || "";
    return host.startsWith("localhost") || host.startsWith("127.0.0.1");
  }

  const auth = req.headers.get("authorization");
  if (auth === `Bearer ${expected}`) return true;

  const { searchParams } = new URL(req.url);
  return searchParams.get("secret") === expected;
}

async function run() {
  const started = Date.now();
  const summary = await syncAllConnectedUsers();
  return {
    ...summary,
    durationMs: Date.now() - started,
    ranAt: new Date().toISOString(),
  };
}

export async function GET(req: NextRequest) {
  if (!isAuthorised(req)) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  try {
    return NextResponse.json(await run());
  } catch (error: any) {
    console.error("Strava cron failed:", error);
    return NextResponse.json(
      { error: error.message || "Sync job failed" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  return GET(req);
}

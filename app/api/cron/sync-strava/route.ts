import { NextRequest, NextResponse } from "next/server";
import { runSyncNow } from "@/lib/scheduler";

export const maxDuration = 300;

/**
 * Manual / external trigger for the Strava sync.
 *
 * The routine sync is armed in `instrumentation.ts` and runs inside the server
 * on a timer — this endpoint is a manual override and a way for an external
 * scheduler to force a run. Both call the same `runSyncNow()`.
 *
 * Add `?force=1` to sync even if the athlete was synced very recently.
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

async function run(force: boolean) {
  const summary = await runSyncNow({ force });
  return {
    ...summary,
    ranAt: new Date().toISOString(),
  };
}

export async function GET(req: NextRequest) {
  if (!isAuthorised(req)) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  try {
    const force = new URL(req.url).searchParams.get("force") === "1";
    return NextResponse.json(await run(force));
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

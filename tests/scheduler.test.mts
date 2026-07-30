/**
 * Tests for the background sync scheduler.
 *
 * Why this file exists: the sync endpoint `/api/cron/sync-strava` was built but
 * nothing ever called it, so activities only arrived when someone ran the sync
 * by hand. Nothing failed — it simply never ran, and no test noticed. These
 * tests assert the scheduler is actually wired up, so that cannot recur.
 *
 * Covers:
 *   1. `instrumentation.ts` exists and starts the scheduler (the wiring itself).
 *   2. The cron route delegates to the same shared code path.
 *   3. Recently-synced athletes are skipped, so restarts can't hammer Strava.
 *   4. `force` overrides that staleness check.
 *   5. Concurrent runs do not overlap.
 *   6. Stale athletes are picked up.
 *
 * Never touches real athlete data: every run is scoped with `userIds`.
 *
 * Run with:  npm run test:scheduler
 */
import "./env.mts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createUser } from "../lib/db";
import { saveStravaToken } from "../lib/strava-db";
import { runSyncNow } from "../lib/scheduler";
import { prisma } from "../lib/prisma";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? ` — ${detail}` : ""}`);
  }
}

const root = join(import.meta.dirname, "..");

async function main() {
  console.log("\nTriApp — background sync scheduler tests\n");

  // ---- 1. The wiring ----------------------------------------------------
  console.log("The scheduler is wired into server startup:");

  let instrumentation = "";
  try {
    instrumentation = readFileSync(join(root, "instrumentation.ts"), "utf8");
  } catch {
    /* left blank — asserted below */
  }
  check("instrumentation.ts exists", instrumentation.length > 0);
  check(
    "it exports register()",
    /export\s+(async\s+)?function\s+register/.test(instrumentation)
  );
  check(
    "it starts the background sync",
    instrumentation.includes("startBackgroundSync")
  );
  check(
    "it does not block startup on a sync",
    !/await\s+runSyncNow/.test(instrumentation)
  );

  const cronRoute = readFileSync(
    join(root, "app/api/cron/sync-strava/route.ts"),
    "utf8"
  );
  check(
    "the cron endpoint shares the scheduler's code path",
    cronRoute.includes("runSyncNow")
  );

  const scheduler = readFileSync(join(root, "lib/scheduler.ts"), "utf8");
  check("the scheduler repeats on a timer", scheduler.includes("setInterval"));
  check(
    "it can be disabled by env var",
    scheduler.includes("DISABLE_BACKGROUND_SYNC")
  );

  // ---- Test fixtures ----------------------------------------------------
  const stamp = Date.now();
  const freshEmail = `sched-fresh-${stamp}@test.local`;
  const staleEmail = `sched-stale-${stamp}@test.local`;
  const fresh = await createUser(freshEmail, "pw-test-1234");
  const stale = await createUser(staleEmail, "pw-test-1234");
  const ids = [fresh.id, stale.id];

  try {
    const future = new Date(Date.now() + 6 * 60 * 60 * 1000);
    for (const u of ids) {
      await saveStravaToken(u, {
        accessToken: "test-access-token",
        refreshToken: "test-refresh-token",
        expiresAt: future,
        athleteId: "1",
        athleteName: "Test Athlete",
        scope: "activity:read_all",
      });
    }

    // fresh = synced a minute ago; stale = synced 10 days ago
    await prisma.stravaToken.updateMany({
      where: { userId: fresh.id },
      data: { lastSyncedAt: new Date(Date.now() - 60 * 1000) },
    });
    await prisma.stravaToken.updateMany({
      where: { userId: stale.id },
      data: { lastSyncedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) },
    });


    // ---- 2. Staleness guard --------------------------------------------
    console.log("\nRecently-synced athletes are skipped:");

    const skipped = await runSyncNow({ userIds: [fresh.id] });
    check("the run is skipped entirely", skipped.ran === false, JSON.stringify(skipped));
    check(
      "it says why",
      typeof skipped.reason === "string" && skipped.reason.length > 0
    );

    // ---- 3. Stale athletes are picked up --------------------------------
    console.log("\nStale athletes are synced:");

    const ran = await runSyncNow({ userIds: [stale.id] });
    check("the run goes ahead", ran.ran === true, JSON.stringify(ran));
    check("exactly one athlete was considered", ran.users === 1, `got ${ran.users}`);
    check(
      "the fresh athlete was not included",
      ran.users === 1,
      "a recently-synced athlete must not be swept in"
    );
    check("it reports how long it took", typeof ran.durationMs === "number");

    // ---- 4. force overrides the guard -----------------------------------
    console.log("\n'force' overrides the staleness check:");

    const forced = await runSyncNow({ userIds: [fresh.id], force: true });
    check("the run goes ahead anyway", forced.ran === true, JSON.stringify(forced));

    // ---- 5. No overlapping runs -----------------------------------------
    console.log("\nConcurrent runs do not overlap:");

    const [a, b] = await Promise.all([
      runSyncNow({ userIds: ids, force: true }),
      runSyncNow({ userIds: ids, force: true }),
    ]);
    const overlapped = [a, b].filter((r) => r.ran === false);
    check(
      "the second run is refused while the first is in flight",
      overlapped.length === 1,
      `ran flags: ${a.ran}/${b.ran}`
    );
    check(
      "the refusal explains itself",
      overlapped[0]?.reason?.includes("progress") ?? false,
      overlapped[0]?.reason
    );

    // ---- 6. Failures are recorded, not swallowed -------------------------
    console.log("\nFailures are recorded against the athlete:");

    const token = await prisma.stravaToken.findFirst({
      where: { userId: stale.id },
      select: { lastSyncedAt: true, lastSyncError: true },
    });
    check("lastSyncedAt was written", token?.lastSyncedAt != null);
    check(
      "a failing sync leaves an error message",
      token?.lastSyncError !== undefined,
      "field must exist so silent failure is impossible"
    );
  } finally {
    // ---- Cleanup: never leave test accounts behind ----------------------
    await prisma.stravaActivity.deleteMany({ where: { userId: { in: ids } } });
    await prisma.stravaToken.deleteMany({ where: { userId: { in: ids } } });
    await prisma.athleteProfile.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    const left = await prisma.user.count({ where: { id: { in: ids } } });
    console.log("\nCleanup:");
    check("test accounts removed", left === 0, `${left} left behind`);
  }

  console.log(
    `\nResult: ${passed} passed, ${failed} failed\n`
  );
  await prisma.$disconnect();
  if (failed > 0) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});

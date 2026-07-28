/**
 * Standalone daily Strava sync.
 *
 * Runs without the web server, so it can be scheduled directly by macOS cron
 * (or any scheduler) even when the app isn't open.
 *
 *   npm run sync:strava
 */
import "../tests/env.mts";
import { syncAllConnectedUsers } from "../lib/strava-db";
import { prisma } from "../lib/prisma";

async function main() {
  const started = Date.now();
  const stamp = new Date().toISOString();
  console.log(`[${stamp}] Starting Strava sync...`);

  try {
    const summary = await syncAllConnectedUsers();

    for (const r of summary.results) {
      if (r.ok) {
        console.log(
          `  ✓ ${r.email ?? r.userId}: ${r.added} new (${r.fetched} checked)`
        );
      } else {
        console.log(`  ✗ ${r.email ?? r.userId}: ${r.error}`);
      }
    }

    console.log(
      `[${new Date().toISOString()}] Done in ${Math.round(
        (Date.now() - started) / 1000
      )}s — ${summary.users} athlete(s), ${summary.totalAdded} new activities, ${
        summary.failed
      } failed.`
    );

    process.exitCode = summary.failed > 0 ? 1 : 0;
  } catch (error: any) {
    console.error(`[${new Date().toISOString()}] Sync job crashed:`, error.message);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main();

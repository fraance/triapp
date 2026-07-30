import { syncAllConnectedUsers } from "./strava-db";
import { prisma } from "./prisma";

/**
 * In-process background scheduler for the Strava sync.
 *
 * Why in-process rather than a hosted cron:
 * `/api/cron/sync-strava` existed for months but nothing ever called it, so
 * activities only arrived when someone ran `npm run sync:strava` by hand. A
 * scheduler that lives inside the app cannot be forgotten, needs no extra
 * Railway service, and keeps working if the host changes. Railway runs a
 * long-lived Node process (`next start`), so timers survive.
 *
 * The cron endpoint is kept as a manual/external trigger; both share the same
 * `runSyncNow()` so behaviour cannot drift.
 */

const HOURS = 60 * 60 * 1000;

/** How often the sync runs. */
const INTERVAL_MS = Number(process.env.SYNC_INTERVAL_HOURS ?? 6) * HOURS;

/** Wait after boot so startup isn't competing with the first requests. */
const STARTUP_DELAY_MS = 30 * 1000;

/**
 * An athlete is only synced if their last sync is older than this. Protects
 * Strava's rate limit when the server restarts repeatedly (deploys, crash
 * loops) and stops several instances duplicating each other's work.
 */
const MIN_AGE_MS = Number(process.env.SYNC_MIN_AGE_HOURS ?? 3) * HOURS;

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export interface SyncRunResult {
  ran: boolean;
  reason?: string;
  users?: number;
  succeeded?: number;
  failed?: number;
  totalAdded?: number;
  durationMs?: number;
}

/**
 * Syncs every athlete whose data is stale.
 *
 * @param force ignore the staleness check (used by the manual endpoint).
 * @param userIds restrict to specific accounts — tests rely on this so the job
 *   can never touch a real athlete's data.
 */
export async function runSyncNow(
  { force = false, userIds }: { force?: boolean; userIds?: string[] } = {}
): Promise<SyncRunResult> {
  if (running) return { ran: false, reason: "a sync is already in progress" };

  running = true;
  const started = Date.now();
  try {
    let targets = userIds;

    if (!force) {
      const cutoff = new Date(Date.now() - MIN_AGE_MS);
      const stale = await prisma.stravaToken.findMany({
        where: {
          ...(userIds ? { userId: { in: userIds } } : {}),
          OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: cutoff } }],
        },
        select: { userId: true },
      });
      if (stale.length === 0) {
        return { ran: false, reason: "every athlete was synced recently" };
      }
      targets = stale.map((t) => t.userId);
    }

    const summary = await syncAllConnectedUsers(
      targets ? { userIds: targets } : {}
    );

    const durationMs = Date.now() - started;
    console.log(
      `[strava-sync] ${summary.succeeded}/${summary.users} athletes ok, ` +
        `${summary.totalAdded} new activities, ${durationMs}ms`
    );
    for (const r of summary.results.filter((r) => !r.ok)) {
      console.error(`[strava-sync] ${r.email ?? r.userId} failed: ${r.error}`);
    }

    return { ran: true, ...summary, durationMs };
  } finally {
    running = false;
  }
}

/**
 * Starts the repeating sync. Safe to call more than once.
 * Set `DISABLE_BACKGROUND_SYNC=1` to turn it off (CI, local debugging).
 */
export function startBackgroundSync(): void {
  if (timer) return;
  if (process.env.DISABLE_BACKGROUND_SYNC === "1") {
    console.log("[strava-sync] background sync disabled by env var");
    return;
  }

  const tick = () => {
    // Never let a background failure take the server down.
    runSyncNow().catch((e) =>
      console.error("[strava-sync] run failed:", e?.message ?? e)
    );
  };

  setTimeout(tick, STARTUP_DELAY_MS).unref?.();
  timer = setInterval(tick, INTERVAL_MS);
  timer.unref?.();

  console.log(
    `[strava-sync] scheduled every ${INTERVAL_MS / HOURS}h ` +
      `(first run in ${STARTUP_DELAY_MS / 1000}s)`
  );
}

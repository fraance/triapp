import { syncAllConnectedUsers } from "./strava-db";
import { prisma } from "./prisma";
import { adaptPlanForUser } from "./adaptation/engine";
import { reconcilePlanWithActivities } from "./adaptation/reconcile";

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
  /** How many athletes had their plan changed as a result. */
  /** Past sessions updated to match what was actually done. */
  reconciled?: number;
  adapted?: number;
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

    // New activity is exactly when the plan may need to change, so the
    // adaptation engine runs off the back of a successful sync (spec: the
    // event-driven adaptation loop). Failures here must never fail the sync.
    let adapted = 0;
    let reconciled = 0;
    const adaptationOff = process.env.DISABLE_ADAPTATION === "1";
    for (const r of summary.results) {
      if (!r.ok) continue;

      // Reconciliation runs regardless of whether adaptation is enabled: the
      // plan must always show what actually happened, even if we choose not to
      // change anything in response.
      try {
        const rec = await reconcilePlanWithActivities(r.userId);
        reconciled += rec.changes.length;
        if (rec.changes.length > 0) {
          console.log(
            `[reconcile] ${r.email ?? r.userId}: ${rec.completed} completed, ` +
              `${rec.substituted} substituted, ${rec.missed} missed`
          );
        }
      } catch (e: any) {
        console.error(
          `[reconcile] ${r.email ?? r.userId} failed: ${e?.message ?? e}`
        );
      }

      if (adaptationOff) continue;
      try {
        const outcome = await adaptPlanForUser(r.userId, { trigger: "strava_sync" });
        if (outcome.outcome === "applied") {
          adapted++;
          console.log(
            `[adaptation] ${r.email ?? r.userId}: ${outcome.changes?.length ?? 0} change(s) — ${outcome.explanation}`
          );
        }
      } catch (e: any) {
        console.error(
          `[adaptation] ${r.email ?? r.userId} failed: ${e?.message ?? e}`
        );
      }
    }

    const durationMs = Date.now() - started;
    console.log(
      `[strava-sync] ${summary.succeeded}/${summary.users} athletes ok, ` +
        `${summary.totalAdded} new activities, ${reconciled} session(s) reconciled, ` +
        `${adapted} plan(s) adapted, ${durationMs}ms`
    );
    for (const r of summary.results.filter((r) => !r.ok)) {
      console.error(`[strava-sync] ${r.email ?? r.userId} failed: ${r.error}`);
    }

    return { ran: true, ...summary, reconciled, adapted, durationMs };
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

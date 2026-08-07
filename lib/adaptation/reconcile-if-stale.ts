/**
 * Reconciliation on view load.
 *
 * The season and today screens used to be pure reads: they only reflected
 * whatever the last sync or adaptation had already written into `plannedSession`.
 * That made the calendar silently lag Strava — an activity synced after the last
 * background job never appeared until the next sync happened to fire, and the
 * athlete kept reporting "my calendar doesn't match Strava".
 *
 * This helper makes the views self-correcting. It is cheap to call: it checks a
 * single marker — whether any Strava activity is newer than the last plan row
 * that was already linked to one — and only runs the (idempotent) reconcile when
 * that is true. Reconcile itself is safe to re-run (see reconcile.ts), so the
 * worst case is a few no-op queries on a view that is already up to date.
 */
import { prisma } from "../prisma";
import { reconcilePlanWithActivities } from "./reconcile";

/**
 * Reconciles the plan against Strava if anything arrived since the last time
 * the plan was updated from an activity.
 *
 * @returns true if a reconcile actually ran.
 */
export async function reconcileIfStale(userId: string): Promise<boolean> {
  try {
    const plan = await prisma.trainingPlan.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (!plan) return false;

    // The newest activity the plan has already absorbed (any session created or
    // updated from a Strava activity counts as "absorbed").
    const latestLinked = await prisma.plannedSession.findFirst({
      where: { planId: plan.id, sourceActivityId: { not: null } },
      orderBy: { updatedAt: "desc" },
      select: { updatedAt: true },
    });

    // The newest real activity Strava holds for this athlete. Zero-second
    // Strava artefacts are excluded, matching the reconcile filter.
    const newest = await prisma.stravaActivity.findFirst({
      where: { userId, movingTime: { gt: 60 } },
      orderBy: { startDate: "desc" },
      select: { id: true },
    });
    if (!newest) return false;

    // Has the plan absorbed it? If the newest activity is already linked to a
    // planned row, the plan is up to date with Strava and there is nothing to
    // do. (Comparing against `updatedAt` of any recent row was wrong: a mere
    // adaptation edit moves that clock past an unabsorbed sync.)
    const absorbed = await prisma.plannedSession.findFirst({
      where: { planId: plan.id, sourceActivityId: newest.id },
      select: { id: true },
    });
    if (absorbed) return false;

    await reconcilePlanWithActivities(userId, {});
    return true;
  } catch (e) {
    // A view must never 500 because reconciliation hiccuped; the data is read
    // stale for one load rather than lost.
    console.error("[reconcile-if-stale] failed:", e);
    return false;
  }
}
/**
 * Reconciliation: writes what actually happened back onto the plan.
 *
 * This closes the gap that made the plan look static. Activities synced from
 * Strava were stored, but nothing ever linked them to the planned sessions, so:
 *   - the week's log still showed every session as "planned", and
 *   - the drift engine had no completed sessions to compare against, so it
 *     concluded there was nothing to react to and left the plan alone.
 *
 * Reconciliation is deliberately **day-level**, not discipline-level. The case
 * that matters most is exactly the one where the athlete did something
 * *different* — swapped a run for a ride, or did a session on the wrong day. A
 * matcher that only pairs like with like is blind to precisely those deviations.
 *
 * Idempotent: running it repeatedly converges on the same result.
 */
import { prisma } from "../prisma";
import { localISO, loadVectorFor, normaliseDiscipline } from "./load-vector";

export type SessionOutcome =
  | "completed" // did what was planned, in the right discipline
  | "substituted" // trained that day, but not the planned discipline
  | "missed"; // the day passed with no training at all

export interface ReconcileResult {
  examined: number;
  completed: number;
  substituted: number;
  missed: number;
  /** Activities that matched no planned session at all. */
  unplanned: number;
  changes: Array<{
    date: string;
    planned: string;
    plannedTss: number;
    outcome: SessionOutcome;
    actual?: string;
    actualTss?: number;
  }>;
}

function startOfDayLocal(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/**
 * Reconciles the athlete's plan against their synced activities.
 *
 * @param lookbackDays how far back to reconcile. Only days that have fully
 *   passed are judged — today is still in progress, so a session with no
 *   activity yet is not "missed".
 */
export async function reconcilePlanWithActivities(
  userId: string,
  opts: { now?: Date; lookbackDays?: number; dryRun?: boolean } = {}
): Promise<ReconcileResult> {
  const now = opts.now ?? new Date();
  const lookback = opts.lookbackDays ?? 21;
  const today = startOfDayLocal(now);
  const from = addDays(today, -lookback);

  const empty: ReconcileResult = {
    examined: 0,
    completed: 0,
    substituted: 0,
    missed: 0,
    unplanned: 0,
    changes: [],
  };

  const plan = await prisma.trainingPlan.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (!plan) return empty;

  // Only past days are judged. `lt: today` deliberately excludes today.
  const sessions = await prisma.plannedSession.findMany({
    where: {
      planId: plan.id,
      scheduledDate: { gte: from, lt: today },
    },
    orderBy: { scheduledDate: "asc" },
  });

  const activities = await prisma.stravaActivity.findMany({
    where: { userId, startDate: { gte: from, lt: addDays(today, 1) } },
    orderBy: { startDate: "asc" },
  });

  // Bucket activities by local calendar day.
  const byDay = new Map<string, typeof activities>();
  for (const a of activities) {
    const key = localISO(a.startDate);
    byDay.set(key, [...(byDay.get(key) ?? []), a]);
  }

  const consumed = new Set<string>();
  const result: ReconcileResult = { ...empty, changes: [] };

  for (const s of sessions) {
    if (!s.scheduledDate) continue;
    // Never overwrite a judgement the athlete made themselves.
    if (s.status === "skipped") continue;

    result.examined++;
    const day = localISO(s.scheduledDate);
    const sameDay = byDay.get(day) ?? [];
    const plannedDiscipline = normaliseDiscipline(s.discipline);

    // A planned rest day is not something you can miss.
    if (plannedDiscipline === "rest") continue;

    const match = sameDay.find(
      (a) =>
        !consumed.has(a.id) && normaliseDiscipline(a.discipline) === plannedDiscipline
    );

    let outcome: SessionOutcome;
    let actualTss: number | null = null;
    let actualLabel: string | undefined;

    if (match) {
      consumed.add(match.id);
      outcome = "completed";
      actualTss = match.estimatedTss;
      actualLabel = `${match.discipline} ${match.estimatedTss} TSS`;
    } else {
      const other = sameDay.filter((a) => !consumed.has(a.id));
      if (other.length > 0) {
        for (const a of other) consumed.add(a.id);
        outcome = "substituted";
        actualTss = other.reduce((n, a) => n + a.estimatedTss, 0);
        actualLabel = other.map((a) => `${a.discipline} ${a.estimatedTss} TSS`).join(" + ");
      } else {
        outcome = "missed";
      }
    }

    const alreadyRight =
      s.status === outcome && (s.actualTss ?? null) === actualTss;
    if (alreadyRight) {
      result[outcome]++;
      continue;
    }

    result[outcome]++;
    result.changes.push({
      date: day,
      planned: `${s.discipline} ${s.type} ${s.tss} TSS`,
      plannedTss: s.tss,
      outcome,
      actual: actualLabel,
      actualTss: actualTss ?? undefined,
    });

    if (!opts.dryRun) {
      await prisma.plannedSession.update({
        where: { id: s.id },
        data: {
          status: outcome,
          actualTss: actualTss ?? undefined,
          completedAt:
            outcome === "missed" ? null : (match?.startDate ?? s.scheduledDate),
        },
      });
    }
  }

  result.unplanned = activities.filter(
    (a) => !consumed.has(a.id) && localISO(a.startDate) < localISO(today)
  ).length;

  return result;
}

/**
 * Day-level load actually completed, for the drift engine.
 *
 * Returns one entry per past day inside the window with both what was planned
 * and what was done, so a substitution or a missed day produces a real signal
 * instead of silently comparing nothing.
 */
export async function dailyPlannedVsActual(
  userId: string,
  opts: { now?: Date; days?: number } = {}
) {
  const now = opts.now ?? new Date();
  const days = opts.days ?? 4;
  const today = startOfDayLocal(now);
  const from = addDays(today, -days);

  const plan = await prisma.trainingPlan.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (!plan) return [];

  const sessions = await prisma.plannedSession.findMany({
    where: { planId: plan.id, scheduledDate: { gte: from, lt: today } },
    select: { scheduledDate: true, discipline: true, type: true, tss: true },
  });

  const activities = await prisma.stravaActivity.findMany({
    where: { userId, startDate: { gte: from, lt: today } },
    select: {
      startDate: true,
      discipline: true,
      name: true,
      estimatedTss: true,
      distance: true,
      elevationGain: true,
    },
  });

  const dates = new Set<string>();
  for (const s of sessions) if (s.scheduledDate) dates.add(localISO(s.scheduledDate));
  for (const a of activities) dates.add(localISO(a.startDate));

  return [...dates].sort().map((date) => {
    const planned = sessions.filter((s) => localISO(s.scheduledDate!) === date);
    const actual = activities.filter((a) => localISO(a.startDate) === date);
    return {
      date,
      plannedLoad: planned.map((p) =>
        loadVectorFor({ discipline: p.discipline, tss: p.tss, type: p.type })
      ),
      actualLoad: actual.map((a) =>
        loadVectorFor({
          discipline: a.discipline,
          tss: a.estimatedTss,
          type: a.name,
          distanceKm: a.distance ? a.distance / 1000 : null,
          elevationGainM: a.elevationGain,
        })
      ),
    };
  });
}

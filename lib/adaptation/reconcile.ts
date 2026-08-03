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
  | "missed" // the day passed with no training at all
  | "unplanned"; // trained with nothing on the plan for that day

export interface ReconcileResult {
  examined: number;
  completed: number;
  substituted: number;
  missed: number;
  /** Activities that matched no planned session at all. */
  unplanned: number;
  /** Cross-sport swaps detected, for the swap-penalty engine (v3 §5). */
  swaps: Array<{ date: string; plannedDiscipline: string; actualDiscipline: string }>;
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
    swaps: [],
    changes: [],
  };

  const plan = await prisma.trainingPlan.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: { id: true, startDate: true },
  });
  if (!plan) return empty;

  // Training done before the plan existed is history, not plan execution.
  // Without this bound, reconciliation reached back 21 days and manufactured
  // "unplanned" sessions for activities that predated the plan entirely.
  const windowStart =
    plan.startDate && plan.startDate > from ? plan.startDate : from;

  // Only past days are judged. `lt: today` deliberately excludes today.
  const sessions = await prisma.plannedSession.findMany({
    where: {
      planId: plan.id,
      scheduledDate: { gte: windowStart, lt: today },
    },
    orderBy: { scheduledDate: "asc" },
  });

  const activities = await prisma.stravaActivity.findMany({
    where: { userId, startDate: { gte: windowStart, lt: addDays(today, 1) } },
    orderBy: { startDate: "asc" },
  });

  // Bucket activities by local calendar day.
  const byDay = new Map<string, typeof activities>();
  for (const a of activities) {
    const key = localISO(a.startDate);
    byDay.set(key, [...(byDay.get(key) ?? []), a]);
  }

  const consumed = new Set<string>();
  const swaps: Array<{ date: string; plannedDiscipline: string; actualDiscipline: string }> = [];
  const result: ReconcileResult = { ...empty, changes: [], swaps: [] };

  for (const s of sessions) {
    if (!s.scheduledDate) continue;
    // Never overwrite a judgement the athlete made themselves.
    if (s.status === "skipped") continue;
    // Rows we created FROM an activity are a record of what happened, not a
    // plan to be judged. Re-examining them reclassified them on the next pass.
    if (s.sourceActivityId) continue;

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
    // Which activity evidences this. Without it, a session marked done is an
    // assertion the athlete cannot check — and they were right not to trust it.
    let matchedActivityId: string | null = null;

    if (match) {
      consumed.add(match.id);
      outcome = "completed";
      actualTss = match.estimatedTss;
      actualLabel = `${match.discipline} ${match.estimatedTss} TSS`;
      matchedActivityId = match.id;
    } else {
      const other = sameDay.filter((a) => !consumed.has(a.id));
      if (other.length > 0) {
        // v3 §2.4, the Baseline Rule: a completed deviation must NEVER
        // overwrite the planned session. The planned row is kept as a ghost
        // with its prescribed load intact — that is the only baseline we have
        // for measuring intent against reality. The activity is left
        // unconsumed so it gets its own record below, and the UI hides the
        // ghost rather than the database losing it.
        outcome = "substituted";
        actualTss = null;
        actualLabel = other
          .map((a) => `${a.discipline} ${a.estimatedTss} TSS`)
          .join(" + ");
        swaps.push({
          date: day,
          plannedDiscipline: s.discipline,
          actualDiscipline: other[0].discipline,
        });
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
          sourceActivityId: matchedActivityId,
          // Must be the value itself, not `?? undefined`: Prisma treats
          // undefined as "leave unchanged", so a substituted session kept a
          // stale actualTss and the baseline stayed polluted.
          actualTss,
          completedAt:
            outcome === "missed" ? null : (match?.startDate ?? s.scheduledDate),
        },
      });
    }
  }

  // ---- Unplanned training ------------------------------------------------
  // Activities that matched no planned session are real work and must appear
  // in the plan. Otherwise the log shows a rest day where the athlete actually
  // trained, and the week reads as lighter than it was.
  const leftover = activities.filter(
    (a) =>
      !consumed.has(a.id) &&
      localISO(a.startDate) < localISO(today) &&
      // A zero-length activity is a Strava artefact, not training.
      a.movingTime > 60
  );
  result.unplanned = leftover.length;

  // Only report activities we have not already recorded, so a repeat run is a
  // genuine no-op rather than replaying the same "changes" every time.
  const alreadyRecorded = new Set(
    (
      await prisma.plannedSession.findMany({
        where: { planId: plan.id, sourceActivityId: { in: leftover.map((a) => a.id) } },
        select: { sourceActivityId: true },
      })
    ).map((r) => r.sourceActivityId!)
  );
  const newlySeen = leftover.filter((a) => !alreadyRecorded.has(a.id));

  if (!opts.dryRun) {
    for (const a of leftover) {
      const date = localISO(a.startDate);
      await prisma.plannedSession
        .upsert({
          // Unique on (planId, sourceActivityId), so re-running is a no-op.
          where: {
            planId_sourceActivityId: { planId: plan.id, sourceActivityId: a.id },
          },
          create: {
            planId: plan.id,
            week: weekNumberOf(a.startDate, sessions),
            day: WEEKDAYS[a.startDate.getDay()],
            scheduledDate: new Date(date + "T00:00:00"),
            discipline: a.discipline,
            type: "Unplanned",
            duration: `${Math.round(a.movingTime / 60)} min`,
            tss: 0, // never counted as prescribed load
            actualTss: a.estimatedTss,
            status: "unplanned",
            purpose: "Unplanned training",
            completedAt: a.startDate,
            sourceActivityId: a.id,
          },
          update: { actualTss: a.estimatedTss },
        })
        .catch(() => {
          /* a concurrent run already created it */
        });
    }
  }

  for (const a of newlySeen) {
    result.changes.push({
      date: localISO(a.startDate),
      planned: "nothing planned",
      plannedTss: 0,
      outcome: "unplanned" as SessionOutcome,
      actual: `${a.discipline} ${a.estimatedTss} TSS`,
      actualTss: a.estimatedTss,
    });
  }

  result.swaps = swaps;
  return result;
}

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** Best-effort plan week for an unplanned activity, from neighbouring rows. */
function weekNumberOf(
  date: Date,
  sessions: Array<{ scheduledDate: Date | null; week: number }>
): number {
  let best = 1;
  let bestGap = Infinity;
  for (const s of sessions) {
    if (!s.scheduledDate) continue;
    const gap = Math.abs(s.scheduledDate.getTime() - date.getTime());
    if (gap < bestGap) {
      bestGap = gap;
      best = s.week;
    }
  }
  return best;
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

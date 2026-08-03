/**
 * Works out the weekly load budgets for a new plan, from the athlete's real
 * training rather than an estimate.
 *
 * Kept apart from `periodisation.ts` so the maths there stays pure and
 * testable; this is the part that reads the database.
 */
import { prisma } from "../prisma";
import { buildWeeklyBudgets, WeekBudget } from "./periodisation";
import { loadVectorFor, totalLoad, localISO } from "./load-vector";

export interface BudgetBasis {
  budgets: WeekBudget[];
  recentWeeklyLoad: number;
  peakWeeklyLoad: number;
  weeksOfHistory: number;
  /** They have resumed after more than a fortnight off. */
  returningFromBreak: boolean;
  /** The ramp actually applied, after any choice the athlete has made. */
  rampRate: number;
  hoursPerLoad: number | null;
  maxWeeklyHours: number | null;
  basis: string;
}

/**
 * @param totalWeeks weeks to the race, inclusive of race week.
 */
/**
 * The load baseline the ramp guardrail should measure against.
 *
 * Shared with the adaptation engine deliberately: the plan was once generated
 * against one baseline and policed against another, so it breached its own
 * guardrail from the day it was written.
 */
export async function rampBaselineFor(
  userId: string,
  now: Date = new Date()
): Promise<number> {
  const basis = await buildBudgetsForUser(userId, 1, now);
  return basis.recentWeeklyLoad;
}

export async function buildBudgetsForUser(
  userId: string,
  totalWeeks: number,
  now: Date = new Date()
): Promise<BudgetBasis> {
  const since = new Date(now.getTime() - 84 * 86400000); // 12 weeks

  const [activities, availability] = await Promise.all([
    prisma.stravaActivity.findMany({
      where: { userId, startDate: { gte: since } },
      select: {
        startDate: true, discipline: true, name: true, estimatedTss: true,
        movingTime: true, distance: true, elevationGain: true,
      },
    }),
    prisma.trainingAvailability.findUnique({ where: { userId } }),
  ]);

  // Bucket into calendar weeks of real, completed training.
  const byWeek = new Map<string, { load: number; seconds: number }>();
  for (const a of activities) {
    const d = new Date(a.startDate);
    const monday = new Date(d);
    monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const key = localISO(monday);
    const load = totalLoad(
      loadVectorFor({
        discipline: a.discipline, tss: a.estimatedTss, type: a.name,
        distanceKm: a.distance ? a.distance / 1000 : null,
        elevationGainM: a.elevationGain,
      })
    );
    const cur = byWeek.get(key) ?? { load: 0, seconds: 0 };
    byWeek.set(key, { load: cur.load + load, seconds: cur.seconds + a.movingTime });
  }

  // Ignore the current, part-finished week — it would understate them.
  const thisMonday = new Date(now);
  thisMonday.setDate(now.getDate() - ((now.getDay() + 6) % 7));

  // Walk every calendar week in the window, including the ones with no
  // training. Taking "the last four weeks that had activity" silently skipped
  // rest and travel weeks, which inflated the average and put the budget
  // above what the ramp guardrail would ever allow.
  const complete: Array<[string, { load: number; seconds: number }]> = [];
  const cursor = new Date(since);
  cursor.setDate(cursor.getDate() - ((cursor.getDay() + 6) % 7));
  while (localISO(cursor) < localISO(thisMonday)) {
    const key = localISO(cursor);
    complete.push([key, byWeek.get(key) ?? { load: 0, seconds: 0 }]);
    cursor.setDate(cursor.getDate() + 7);
  }

  // A break changes what "recent" means. Averaging four weeks across a month
  // off gives a baseline far below what the athlete is currently doing, and a
  // plan built on it would be uselessly light. LOGIC_V2 §2.3 H1 handles this
  // explicitly: after more than a fortnight off, ramp from where they have
  // resumed, but ramp more cautiously.
  const trailing = complete.slice(-8);
  let sinceBreak = trailing;
  for (let i = trailing.length - 1; i >= 1; i--) {
    const [, week] = trailing[i];
    const [, prev] = trailing[i - 1];
    if (week.load > 0 && prev.load === 0) {
      sinceBreak = trailing.slice(i);
      break;
    }
  }

  // Only treat it as a return if they have actually been back for a week or
  // two — one session back does not establish a baseline.
  const returningFromBreak =
    sinceBreak.length >= 1 && sinceBreak.length < trailing.length && sinceBreak.length <= 4;

  const recentWeeks = returningFromBreak ? sinceBreak : complete.slice(-4);
  const loads = recentWeeks.map(([, v]) => v.load);
  const recentWeeklyLoad =
    loads.length > 0 ? loads.reduce((n, l) => n + l, 0) / loads.length : 0;
  const peakWeeklyLoad = complete.length > 0
    ? Math.max(...complete.map(([, v]) => v.load))
    : 0;

  const totalLoadAll = complete.reduce((n, [, v]) => n + v.load, 0);
  const totalSeconds = complete.reduce((n, [, v]) => n + v.seconds, 0);
  const hoursPerLoad =
    totalLoadAll > 0 ? totalSeconds / 3600 / totalLoadAll : null;

  // Declared availability is a ceiling, minus a buffer so life fits too.
  let maxWeeklyHours: number | null = null;
  if (availability && !availability.noTimeConstraints) {
    const declared =
      availability.monHours + availability.tueHours + availability.wedHours +
      availability.thuHours + availability.friHours + availability.satHours +
      availability.sunHours;
    if (declared > 0) maxWeeklyHours = declared * 0.88;
  }

  // The athlete's own answer about how hard to rebuild wins over the default.
  // The engine still holds every other guardrail regardless.
  const { preferredRampRate } = await import("./decisions");
  const chosenRamp = await preferredRampRate(userId);

  const budgets = buildWeeklyBudgets({
    totalWeeks,
    recentWeeklyLoad,
    peakWeeklyLoad,
    hoursPerLoad,
    maxWeeklyHours,
    // Coming back from time off, tissue tolerance lags fitness. Ramp slower,
    // unless the athlete has told us the break was nothing to do with injury.
    rampRate: chosenRamp ?? (returningFromBreak ? 0.05 : undefined),
  });

  // Put the judgement call to the athlete rather than quietly deciding how
  // ambitious their comeback should be.
  if (returningFromBreak && chosenRamp === null && budgets.length > 0) {
    try {
      const { askAboutComeback } = await import("./decisions");
      await askAboutComeback(userId, {
        recentWeeklyLoad: Math.round(recentWeeklyLoad),
        peakWeeklyLoad: Math.round(peakWeeklyLoad),
        weekOneLoad: budgets[0].targetLoad,
        weekOneHours: budgets[0].targetHours,
        weeksToRace: totalWeeks,
      });
    } catch (e) {
      console.error("Could not raise the comeback decision:", e);
    }
  }

  return {
    budgets,
    recentWeeklyLoad: Math.round(recentWeeklyLoad),
    peakWeeklyLoad: Math.round(peakWeeklyLoad),
    weeksOfHistory: complete.length,
    returningFromBreak,
    rampRate: chosenRamp ?? (returningFromBreak ? 0.05 : 0.08),
    hoursPerLoad,
    maxWeeklyHours,
    basis:
      complete.length > 0
        ? `${complete.length} complete weeks tracked; averaging ${Math.round(
            recentWeeklyLoad
          )} load over the last ${recentWeeks.length} week${recentWeeks.length === 1 ? "" : "s"}` +
          (returningFromBreak ? " since you resumed after a break (slower ramp applied)" : "") +
          `, best week ${Math.round(peakWeeklyLoad)}`
        : "no training history — starting deliberately low",
  };
}

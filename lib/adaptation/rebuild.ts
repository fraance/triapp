/**
 * Rebuilds a plan around what the athlete is actually training.
 *
 * Extracted so the same path serves the athlete pressing "rebuild" and any
 * future automatic trigger — there must be exactly one way a plan comes into
 * existence, or they will drift.
 */
import { prisma } from "../prisma";
import { buildBudgetsForUser } from "./plan-budget";
import { generateTrainingPlan, weeksUntilRace } from "../ai-coach";
import { buildAthleteContext } from "../athlete-context";
import { saveFullPlan, rebuildFutureSessions } from "../db";
import { mondayOfWeek } from "../plan-dates";

export async function rebuildPlan(
  userId: string,
  opts: { now?: Date } = {}
): Promise<{ weeks: number; keptSessions: number; startedOver: boolean }> {
  const now = opts.now ?? new Date();

  const [existing, profile] = await Promise.all([
    prisma.trainingPlan.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: { targetRaceDate: true, startDate: true },
    }),
    prisma.athleteProfile.findUnique({ where: { userId } }),
  ]);

  const raceDate =
    existing?.targetRaceDate ??
    profile?.raceDate ??
    new Date(Date.now() + 16 * 7 * 86400000);

  // Keep the plan's own start date. Anchoring a rebuild to today pushed week 1
  // forward and orphaned the week the athlete had just trained — their history
  // stopped being part of their plan.
  const planStart = existing?.startDate ?? mondayOfWeek(now);

  const totalWeeks = weeksUntilRace(raceDate, planStart);
  if (totalWeeks < 1) throw new Error("The race date has already passed.");

  const basis = await buildBudgetsForUser(userId, totalWeeks, now);
  const context = await buildAthleteContext(userId);

  const result = await generateTrainingPlan(
    {
      ...(profile as never as Record<string, unknown>),
      raceDate: raceDate.toISOString().slice(0, 10),
    } as never,
    context,
    { detailWeeks: "all", budgets: basis.budgets }
  );

  // A first plan is created outright; an existing one is rebuilt from today
  // forward, so completed training stays exactly where it is.
  if (!existing) {
    await saveFullPlan(userId, raceDate, result.weeks, planStart, result.outline);
    return { weeks: totalWeeks, keptSessions: 0, startedOver: true };
  }

  const { kept } = await rebuildFutureSessions(
    userId,
    result.weeks,
    result.outline,
    now
  );

  return { weeks: totalWeeks, keptSessions: kept, startedOver: false };
}

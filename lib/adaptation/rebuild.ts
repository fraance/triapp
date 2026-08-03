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
import { saveFullPlan } from "../db";

export async function rebuildPlan(userId: string): Promise<{ weeks: number }> {
  const [existing, profile] = await Promise.all([
    prisma.trainingPlan.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: { targetRaceDate: true },
    }),
    prisma.athleteProfile.findUnique({ where: { userId } }),
  ]);

  const raceDate =
    existing?.targetRaceDate ??
    profile?.raceDate ??
    new Date(Date.now() + 16 * 7 * 86400000);

  const totalWeeks = weeksUntilRace(raceDate);
  if (totalWeeks < 1) throw new Error("The race date has already passed.");

  const basis = await buildBudgetsForUser(userId, totalWeeks);
  const context = await buildAthleteContext(userId);

  const result = await generateTrainingPlan(
    {
      ...(profile as never as Record<string, unknown>),
      raceDate: raceDate.toISOString().slice(0, 10),
    } as never,
    context,
    { detailWeeks: "all", budgets: basis.budgets }
  );

  await saveFullPlan(userId, raceDate, result.weeks, new Date(), result.outline);

  return { weeks: totalWeeks };
}

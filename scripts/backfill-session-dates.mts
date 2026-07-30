/**
 * Backfills PlannedSession.scheduledDate using the app's own date logic, so
 * stored dates always agree with what the UI computes.
 *
 * The SQL in the migration could not do this safely: plan startDates carry
 * timezone artefacts, and only lib/plan-dates.ts knows how to normalise them.
 *
 * Idempotent — safe to run repeatedly.
 *
 * Run with: npx tsx scripts/backfill-session-dates.mts
 */
import "../tests/env.mts";
import { prisma } from "../lib/prisma";
import { sessionDate } from "../lib/plan-dates";

async function main() {
  const plans = await prisma.trainingPlan.findMany({
    select: { id: true, startDate: true, sessions: { select: { id: true, week: true, day: true, scheduledDate: true } } },
  });

  let updated = 0;
  let unchanged = 0;
  let skipped = 0;

  for (const plan of plans) {
    if (!plan.startDate) {
      skipped += plan.sessions.length;
      continue;
    }
    for (const s of plan.sessions) {
      const correct = sessionDate(plan.startDate, s.week, s.day);
      if (!correct) {
        skipped++;
        continue;
      }
      const current = s.scheduledDate;
      if (current && current.getTime() === correct.getTime()) {
        unchanged++;
        continue;
      }
      await prisma.plannedSession.update({
        where: { id: s.id },
        // originalDate tracks where a session began, for the change log.
        data: { scheduledDate: correct, originalDate: correct },
      });
      updated++;
    }
  }

  console.log(`plans: ${plans.length}`);
  console.log(`  corrected: ${updated}`);
  console.log(`  already right: ${unchanged}`);
  console.log(`  skipped (no start date / bad day name): ${skipped}`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});

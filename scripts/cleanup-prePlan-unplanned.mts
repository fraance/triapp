/**
 * Removes "unplanned" session records created for activities that happened
 * BEFORE the plan started.
 *
 * Reconciliation looked back a fixed 21 days without bounding on the plan's
 * start date, so training done before the plan existed was written into it as
 * unplanned sessions. That is history, not plan execution: it cluttered the
 * calendar and dragged zero-value rows in with it.
 *
 * The underlying cause is fixed in lib/adaptation/reconcile.ts. This clears up
 * what the old behaviour already wrote.
 *
 * Only ever deletes rows that are (a) status "unplanned", (b) linked to a
 * source activity, and (c) dated before the plan start. The Strava activities
 * themselves are untouched.
 *
 * Run with: npx tsx scripts/cleanup-prePlan-unplanned.mts [--apply]
 */
import "../tests/env.mts";
import { prisma } from "../lib/prisma";

async function main() {
  const apply = process.argv.includes("--apply");

  const plans = await prisma.trainingPlan.findMany({
    select: { id: true, startDate: true, userId: true },
  });

  let total = 0;
  for (const plan of plans) {
    if (!plan.startDate) continue;
    const stale = await prisma.plannedSession.findMany({
      where: {
        planId: plan.id,
        status: "unplanned",
        sourceActivityId: { not: null },
        scheduledDate: { lt: plan.startDate },
      },
      select: { id: true, scheduledDate: true, discipline: true, actualTss: true },
    });
    if (stale.length === 0) continue;

    console.log(`plan ${plan.id} (starts ${plan.startDate.toDateString()}):`);
    for (const s of stale) {
      console.log(
        `   ${s.scheduledDate?.toDateString()}  ${s.discipline}  actualTss=${s.actualTss}`
      );
    }
    total += stale.length;

    if (apply) {
      await prisma.plannedSession.deleteMany({
        where: { id: { in: stale.map((s) => s.id) } },
      });
    }
  }

  console.log(
    apply
      ? `\nremoved ${total} pre-plan unplanned rows`
      : `\n${total} rows would be removed. Re-run with --apply to do it.`
  );
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});

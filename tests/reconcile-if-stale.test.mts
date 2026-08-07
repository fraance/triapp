/**
 * The calendar must reflect Strava even when nothing has triggered a sync since
 * the activity arrived. Previously the season/today views were pure reads: they
 * only showed what the last sync or adaptation had already written, so an
 * activity that landed after the last background job stayed invisible — the
 * athlete reported "my calendar doesn't match Strava".
 *
 * The fix: `reconcileIfStale` runs on view load and re-reconciles the plan
 * when the newest Strava activity has not yet been absorbed into a planned row.
 *
 * Run with:  npm run test:reconcile-if-stale
 */
import "./env.mts";
import { createUser, saveFullPlan } from "../lib/db";
import { reconcileIfStale } from "../lib/adaptation/reconcile-if-stale";
import { getSeasonView } from "../lib/db";
import { prisma } from "../lib/prisma";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  console.log("\nTriApp — views reconcile on load\n");

  const user = await createUser(`reconcile-if-stale-${Date.now()}@test.local`, "pw-test-1234");

  try {
    const start = new Date(Date.now() - 6 * 86400000);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));

    await saveFullPlan(
      user.id,
      new Date(Date.now() + 30 * 86400000),
      [
        {
          week: 1, phase: "Base",
          sessions: [
            { day: "Monday", discipline: "Swim", type: "Endurance", duration: "45 min", tss: 45 },
          ],
        },
      ],
      start,
      [{ week: 1, phase: "Base" }]
    );

    const plan = await prisma.trainingPlan.findFirst({ where: { userId: user.id } });
    const swim = await prisma.plannedSession.findFirst({ where: { planId: plan!.id, discipline: "Swim" } });
    check("the swim starts out planned", swim?.status === "planned", swim?.status);

    // No reconciliation has happened, so calling reconcileIfStale with an empty
    // Strava history must be a no-op (nothing to absorb).
    const noop = await reconcileIfStale(user.id);
    check("reconcileIfStale is a no-op with no activities", noop === false);

    // Now Strava has a swim that the plan has NOT absorbed — exactly the state
    // after a fresh sync whose reconcile step never ran. The view must pick it
    // up on load.
    const swimDate = new Date(swim!.scheduledDate!);
    swimDate.setHours(18, 0, 0, 0);
    const activity = await prisma.stravaActivity.create({
      data: {
        userId: user.id, stravaId: `stale-${Date.now()}`,
        name: "Evening Swim", discipline: "Swim", sportType: "Swim",
        startDate: swimDate,
        estimatedTss: 27, movingTime: 2400, distance: 1500,
        isTrainer: false, detailsFetched: false,
      },
    });

    // The plan is still stale: the swim is still "planned", nothing absorbed it.
    const stillPlanned = await prisma.plannedSession.findFirst({ where: { planId: plan!.id, discipline: "Swim" } });
    check("before a view load the swim is still planned", stillPlanned?.status === "planned", stillPlanned?.status);

    // The view load calls reconcileIfStale and must reconcile the activity.
    const ran = await reconcileIfStale(user.id);
    check("reconcileIfStale runs when the newest activity is unabsorbed", ran === true);

    const absorbed = await prisma.plannedSession.findFirst({
      where: { planId: plan!.id, discipline: "Swim" },
    });
    check("the swim now shows as done", absorbed?.status === "completed", absorbed?.status);
    check("the activity is linked as evidence", absorbed?.sourceActivityId === activity.id);

    // Re-running must be cheap and idle — nothing new has arrived.
    const again = await reconcileIfStale(user.id);
    check("a second call is a no-op once absorbed", again === false);

    // And the season view, which drives the calendar, now reflects it.
    const view = await getSeasonView(user.id, new Date(Date.now() + 86400000));
    const shown = view.weeks.flatMap((w) => w.sessions).find((s) => s.id === absorbed!.id);
    check("the season view shows the completed swim", shown?.status === "completed", shown?.status);

    // A strava-artefact (near-zero moving time) must never force a reconcile.
    const ghost = await prisma.stravaActivity.create({
      data: {
        userId: user.id, stravaId: `ghost-${Date.now()}`,
        name: "Sync artefact", discipline: "Bike", sportType: "Ride",
        startDate: new Date(Date.now() + 86400000), estimatedTss: 0, movingTime: 23,
        distance: 0, isTrainer: false, detailsFetched: false,
      },
    });
    const ghostRun = await reconcileIfStale(user.id);
    check("a sub-minute artefact does not trigger a reconcile", ghostRun === false);
  } finally {
    const plans = await prisma.trainingPlan.findMany({ where: { userId: user.id }, select: { id: true } });
    await prisma.planWeekOutline.deleteMany({ where: { planId: { in: plans.map((p) => p.id) } } });
    await prisma.plannedSession.deleteMany({ where: { planId: { in: plans.map((p) => p.id) } } });
    await prisma.trainingPlan.deleteMany({ where: { userId: user.id } });
    await prisma.stravaActivity.deleteMany({ where: { userId: user.id } });
    await prisma.athleteProfile.deleteMany({ where: { userId: user.id } });
    await prisma.user.deleteMany({ where: { id: user.id } });
    check("test account removed", (await prisma.user.count({ where: { id: user.id } })) === 0);
  }

  console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
  await prisma.$disconnect();
  if (failed > 0) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});

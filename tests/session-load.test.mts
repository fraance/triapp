/**
 * Completed or unplanned training must carry the load it actually cost, not a
 * zero. The athlete reported unplanned sessions showing "127 TSS" alongside an
 * all-zero cost breakdown (Aerobic 0, Impact 0, High intensity 0, Upper body
 * 0) — which hid exactly the recovery the engine reasons about. A done session
 * is now valued from its executed activity; a raw one stays at its prescribed
 * value.
 *
 * Run with:  npm run test:load
 */
import "./env.mts";
import { createUser, saveFullPlan, getSeasonView } from "../lib/db";
import { loadVectorFor, totalLoad } from "../lib/adaptation/load-vector";
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
  console.log("\nTriApp — completed/ unplanned session load tests\n");

  const user = await createUser(`load-${Date.now()}@test.local`, "pw-test-1234");

  try {
    const START = new Date("2026-08-03T00:00:00"); // a Monday
    await saveFullPlan(
      user.id,
      new Date("2026-09-12T00:00:00"),
      [
        {
          week: 1, phase: "Base",
          sessions: [
            { day: "Monday", discipline: "Swim", type: "Endurance", duration: "45 min", tss: 45 },
            // A future planned session, to be sure the prescribed load is used.
            { day: "Thursday", discipline: "Swim", type: "Drills", duration: "40 min", tss: 30 },
          ],
        },
      ],
      START,
      [{ week: 1, phase: "Base" }]
    );

    const plan = await prisma.trainingPlan.findFirst({ where: { userId: user.id } });

    // The executed activity behind some unplanned completed training.
    const activity = await prisma.stravaActivity.create({
      data: {
        userId: user.id,
        stravaId: `test-${Date.now()}`,
        name: "Evening Ride", discipline: "Bike", sportType: "Ride",
        startDate: new Date("2026-08-05T00:00:00"), // today of the reference view
        estimatedTss: 127, movingTime: 100 * 60, distance: 50_000, elevationGain: 350,
        isTrainer: false, detailsFetched: false,
      },
    });

    // The unplanned row the reconciler writes: prescribed load zero, executed
    // load carried on actualTss and evidenced by the activity.
    await prisma.plannedSession.create({
      data: {
        planId: plan!.id, week: 1, day: "Tuesday",
        scheduledDate: new Date("2026-08-05T00:00:00"),
        discipline: "Bike", type: "Unplanned", duration: "100 min",
        tss: 0, actualTss: 127, status: "unplanned",
        sourceActivityId: activity.id, purpose: "Unplanned training",
        completedAt: new Date("2026-08-05T00:00:00"),
      },
    });

    const view = await getSeasonView(user.id, new Date("2026-08-05T00:00:00"));
    const sessions = view.weeks.flatMap((w) => w.sessions);

    const unplanned = sessions.find((s) => s.status === "unplanned");
    const expected = loadVectorFor({
      discipline: "Bike", tss: 127, type: "Evening Ride", distanceKm: 50, elevationGainM: 350,
    });

    check("an unplanned session is shown", !!unplanned);
    check("its load is not all zeros", unplanned && totalLoad(unplanned.load) > 0,
      totalLoad(unplanned?.load ?? { metabolic: 0, mechanical: 0, neuromuscular: 0, upper: 0 }).toString());
    check("executed load equals the executed activity's breakdown",
      unplanned &&
        Math.round(totalLoad(unplanned.load)) === Math.round(totalLoad(expected)),
      `got ${totalLoad(unplanned?.load ?? expected)} vs ${totalLoad(expected)}`);
    check("impact (mechanical) is carried, not zeroed",
      (unplanned?.load.mechanical ?? 0) > 0, String(unplanned?.load.mechanical));
    check("the athlete never sees the literal word 'Unplanned'",
      unplanned?.type === "Evening Ride", unplanned?.type);

    // A raw planned session is still valued at what was prescribed.
    const planned = sessions.find((s) => s.status === "planned");
    check("a raw planned session keeps its prescribed load",
      planned &&
        Math.round(totalLoad(planned.load)) ===
          Math.round(totalLoad(loadVectorFor({ discipline: "Swim", tss: 30, type: "Drills" }))),
      totalLoad(planned?.load).toString());
  } finally {
    const plans = await prisma.trainingPlan.findMany({
      where: { userId: user.id }, select: { id: true },
    });
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
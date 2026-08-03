/**
 * Rebuilding a plan must not destroy what has already happened.
 *
 * This exists because it did: a regeneration deleted every previous plan and
 * anchored the new week 1 to the current Monday, so a week the athlete had
 * just trained stopped being part of their plan and its history went with it.
 * Training they have actually done is the one thing in the system that cannot
 * be regenerated.
 *
 * Run with:  npm run test:rebuild
 */
import "./env.mts";
import { createUser, rebuildFutureSessions } from "../lib/db";
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
  console.log("\nTriApp — plan rebuild tests\n");

  const user = await createUser(`rebuild-${Date.now()}@test.local`, "pw-test-1234");

  try {
    const start = new Date("2026-07-27T00:00:00"); // a Monday
    const plan = await prisma.trainingPlan.create({
      data: {
        userId: user.id,
        targetRaceDate: new Date("2026-09-12T00:00:00"),
        startDate: start,
        weekCount: 3,
      },
    });

    // Week 1 already happened; week 2 is still ahead.
    await prisma.plannedSession.createMany({
      data: [
        { planId: plan.id, week: 1, day: "Monday",
          scheduledDate: new Date("2026-07-27T00:00:00"),
          discipline: "Swim", type: "Endurance", duration: "45 min",
          tss: 45, status: "completed", actualTss: 40 },
        { planId: plan.id, week: 1, day: "Tuesday",
          scheduledDate: new Date("2026-07-28T00:00:00"),
          discipline: "Bike", type: "Endurance", duration: "60 min",
          tss: 60, status: "skipped" },
        { planId: plan.id, week: 2, day: "Monday",
          scheduledDate: new Date("2026-08-03T00:00:00"),
          discipline: "Run", type: "Endurance", duration: "40 min",
          tss: 40, status: "planned" },
      ],
    });

    const result = await rebuildFutureSessions(
      user.id,
      [
        {
          week: 2, phase: "Build",
          sessions: [
            { day: "Monday", discipline: "Bike", type: "Intervals",
              duration: "60 min", tss: 70, instructions: "new", pace: "" },
          ],
        } as never,
      ],
      [{ week: 2, phase: "Build", targetTss: 300, targetHours: 5 }],
      new Date("2026-08-03T00:00:00")
    );

    const after = await prisma.plannedSession.findMany({
      where: { planId: plan.id },
      orderBy: { scheduledDate: "asc" },
    });

    check("the completed session survives",
      after.some((s) => s.status === "completed" && s.actualTss === 40),
      JSON.stringify(after.map((s) => s.status)));
    check("so does the athlete's own decision to skip",
      after.some((s) => s.status === "skipped"));
    check("the plan record is kept, not replaced",
      (await prisma.trainingPlan.count({ where: { userId: user.id } })) === 1);
    check("the start date is not moved to today",
      (await prisma.trainingPlan.findUnique({ where: { id: plan.id } }))
        ?.startDate?.toDateString() === start.toDateString(),
      "anchoring a rebuild to today orphans the week just trained");
    check("history is reported as kept", result.kept === 2, String(result.kept));

    const future = after.filter((s) => s.scheduledDate! >= new Date("2026-08-03T00:00:00"));
    check("the future is replaced with the new plan",
      future.length === 1 && future[0].discipline === "Bike" && future[0].tss === 70,
      JSON.stringify(future.map((s) => `${s.discipline}/${s.tss}`)));
    check("the old future session is gone",
      !after.some((s) => s.discipline === "Run"));
    check("new sessions are born with a real date",
      future.every((s) => s.scheduledDate !== null));

    // Rebuilding again must be equally safe.
    await rebuildFutureSessions(
      user.id,
      [{ week: 2, phase: "Build", sessions: [] } as never],
      [{ week: 2, phase: "Build" }],
      new Date("2026-08-03T00:00:00")
    );
    const twice = await prisma.plannedSession.findMany({ where: { planId: plan.id } });
    check("rebuilding twice still keeps the past",
      twice.filter((s) => s.status === "completed" || s.status === "skipped").length === 2,
      String(twice.length));
  } finally {
    const plans = await prisma.trainingPlan.findMany({
      where: { userId: user.id }, select: { id: true },
    });
    await prisma.planWeekOutline.deleteMany({ where: { planId: { in: plans.map((p) => p.id) } } });
    await prisma.plannedSession.deleteMany({ where: { planId: { in: plans.map((p) => p.id) } } });
    await prisma.trainingPlan.deleteMany({ where: { userId: user.id } });
    await prisma.athleteProfile.deleteMany({ where: { userId: user.id } });
    await prisma.user.deleteMany({ where: { id: user.id } });
    console.log("\nCleanup:");
    check("test account removed",
      (await prisma.user.count({ where: { id: user.id } })) === 0);
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

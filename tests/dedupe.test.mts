/**
 * Two sessions must never be written onto the same plan day in the same
 * discipline. It happened: the AI emitted two Monday swims and both became
 * separate rows on the same date, so the plan read "Monday swim, and another
 * Monday swim" while Strava showed one. Every write path now collapses such
 * duplicates before persisting.
 *
 * Run with:  npm run test:dedupe
 */
import "./env.mts";
import {
  createUser,
  saveFullPlan,
  rebuildFutureSessions,
  addDetailedWeeks,
} from "../lib/db";
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

const START = new Date("2026-07-27T00:00:00"); // a Monday

function week(week: number, sessions: unknown[]): any[] {
  return [{ week, phase: "Build", sessions }];
}

function swim(day: string, tss: number) {
  return { day, discipline: "Swim", type: "Endurance", duration: "45 min", tss };
}
function ride(day: string, tss: number) {
  return { day, discipline: "Bike", type: "Endurance", duration: "60 min", tss };
}

async function countPlanRows(userId: string): Promise<number> {
  return prisma.plannedSession.count({
    where: { plan: { userId } },
  });
}

async function main() {
  console.log("\nTriApp — plan write dedupe tests\n");

  const user = await createUser(`dedupe-${Date.now()}@test.local`, "pw-test-1234");

  try {
    // saveFullPlan: two identical Monday swims → one row.
    await saveFullPlan(
      user.id,
      new Date("2026-09-12T00:00:00"),
      week(1, [swim("Monday", 45), swim("Monday", 50), ride("Tuesday", 60)]),
      START,
      [{ week: 1, phase: "Build" }]
    );
    let rows = await prisma.plannedSession.findMany({
      where: { plan: { userId: user.id } },
    });
    check("saveFullPlan keeps one session per day+discipline",
      rows.length === 2,
      String(rows.length));
    check("the higher-TSS duplicate is dropped (first wins)",
      rows.every((r) => r.discipline !== "Swim" || r.tss === 45),
      rows.map((r) => `${r.discipline}/${r.tss}`).join(","));
    check("a second discipline on the same day is preserved",
      rows.some((r) => r.discipline === "Bike" && r.day === "Tuesday"),
      rows.map((r) => r.day).join(","));

    // rebuildFutureSessions: same guard on the future-only rebuild.
    const plan = await prisma.trainingPlan.findFirst({ where: { userId: user.id } });
    await rebuildFutureSessions(
      user.id,
      week(2, [swim("Monday", 40), swim("Monday", 42), ride("Monday", 55)]),
      [{ week: 2, phase: "Build" }],
      new Date("2026-08-03T00:00:00")
    );
    rows = await prisma.plannedSession.findMany({
      where: { plan: { userId: user.id } },
    });
    const week2 = rows.filter((r) => r.week === 2);
    check("rebuildFutureSessions collapses same-day swims",
      week2.filter((r) => r.discipline === "Swim").length === 1,
      week2.map((r) => `${r.discipline}/${r.tss}`).join(","));
    check("rebuild keeps an unrelated same-day discipline",
      week2.filter((r) => r.discipline === "Bike").length === 1,
      week2.map((r) => r.discipline).join(","));

    // addDetailedWeeks: idempotent expansion path has the same guard.
    const before = await countPlanRows(user.id);
    await addDetailedWeeks(plan!.id, week(3, [swim("Thursday", 30), swim("Thursday", 35)]));
    const after = await countPlanRows(user.id);
    rows = await prisma.plannedSession.findMany({ where: { plan: { userId: user.id } } });
    const week3 = rows.filter((r) => r.week === 3);
    check("addDetailedWeeks collapses same-day swims",
      week3.filter((r) => r.discipline === "Swim").length === 1,
      week3.map((r) => `${r.discipline}/${r.tss}`).join(","));
    check("addDetailedWeeks is additive across weeks",
      after === before + 1,
      `${before} → ${after}`);

    // Distinct sessions on the same day (different type) must be preserved.
    await saveFullPlan(
      user.id,
      new Date("2026-09-12T00:00:00"),
      week(1, [
        { day: "Thursday", discipline: "Swim", type: "Drills", duration: "45 min", tss: 45 },
        { day: "Thursday", discipline: "Swim", type: "Endurance", duration: "50 min", tss: 50 },
      ]),
      START,
      [{ week: 1, phase: "Build" }]
    );
    rows = await prisma.plannedSession.findMany({
      where: { plan: { userId: user.id } },
    });
    check("distinct sessions on the same day are both kept",
      rows.length === 2,
      rows.map((r) => `${r.day}/${r.type}/${r.tss}`).join(","));
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
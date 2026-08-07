/**
 * The manual "Sync" button (and the Strava connect callback) must reconcile
 * the plan immediately, not just fetch raw activities.
 *
 * This is the bug behind an athlete reporting a session still shown as
 * planned/missed hours after they could see the matching ride on Strava: the
 * manual sync and the OAuth callback only ever called `syncStravaActivities`
 * and left reconciliation to the background job, which could be hours away.
 *
 * Run with:  npm run test:sync-reconcile
 */
import "./env.mts";
import { createUser, saveFullPlan } from "../lib/db";
import { saveStravaToken } from "../lib/strava-db";
import { syncOneUserNow, reconcileAndAdaptUser } from "../lib/scheduler";
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
  console.log("\nTriApp — sync immediately reconciles the plan\n");

  const email = `sync-reconcile-${Date.now()}@test.local`;
  const user = await createUser(email, "pw-test-1234");
  const realFetch = global.fetch;

  try {
    await saveStravaToken(user.id, {
      accessToken: "token", refreshToken: "refresh",
      expiresAt: new Date(Date.now() + 3600_000), athleteName: "Tester",
    });

    // A plan whose Monday swim is still in the future relative to "now" below,
    // so reconciliation is free to judge it once "yesterday" data arrives —
    // scheduledDate must be strictly before `now`'s local day to be examined.
    const start = new Date(Date.now() - 6 * 86400000); // a week-ish ago
    start.setHours(0, 0, 0, 0);
    // Back up to the most recent Monday so the plan's own week arithmetic holds.
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
    const before = await prisma.plannedSession.findFirst({ where: { planId: plan!.id, discipline: "Swim" } });
    check("the swim starts out planned", before?.status === "planned", before?.status);

    // Strava now has a swim on that same Monday.
    const mondayIso = before!.scheduledDate!.toISOString();
    global.fetch = (async () => ({
      ok: true,
      json: async () => [
        {
          id: 5001, name: "Morning Swim", sport_type: "Swim",
          start_date: mondayIso, moving_time: 2700, distance: 2000,
        },
      ],
    })) as any;

    const result = await syncOneUserNow(user.id, { now: new Date() });

    check("the sync reports a reconciled session", result.reconciled >= 1, JSON.stringify(result));

    const after = await prisma.plannedSession.findFirst({ where: { planId: plan!.id, discipline: "Swim" } });
    check("the swim is no longer stuck at 'planned' after one manual sync",
      after?.status === "completed",
      after?.status);
    check("it carries the executed activity as evidence",
      !!after?.sourceActivityId);

    // The OAuth-callback helper does the same reconcile step without syncing.
    const outcome = await reconcileAndAdaptUser(user.id, "strava_connect", new Date());
    check("reconcileAndAdaptUser runs without throwing", typeof outcome.reconciled === "number");
  } finally {
    global.fetch = realFetch;
    const plans = await prisma.trainingPlan.findMany({ where: { userId: user.id }, select: { id: true } });
    await prisma.planWeekOutline.deleteMany({ where: { planId: { in: plans.map((p) => p.id) } } });
    await prisma.plannedSession.deleteMany({ where: { planId: { in: plans.map((p) => p.id) } } });
    await prisma.trainingPlan.deleteMany({ where: { userId: user.id } });
    await prisma.stravaActivity.deleteMany({ where: { userId: user.id } });
    await prisma.stravaToken.deleteMany({ where: { userId: user.id } });
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
/**
 * The athlete must be able to correct what a completed session actually was
 * (e.g. "did 3x3 instead of the prescribed 6x3"), and that correction must
 * reach the algorithm — not just redecorate the calendar.
 *
 * Run with:  npm run test:executed-edit
 */
import "./env.mts";
import { createUser, saveFullPlan, updateExecutedSession, getSeasonView } from "../lib/db";
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
  console.log("\nTriApp — editing an executed session\n");

  const user = await createUser(`executed-edit-${Date.now()}@test.local`, "pw-test-1234");

  try {
    const start = new Date("2026-08-03T00:00:00"); // a Monday
    await saveFullPlan(
      user.id,
      new Date("2026-09-12T00:00:00"),
      [
        {
          week: 1, phase: "Build",
          sessions: [
            { day: "Tuesday", discipline: "Run", type: "Intervals", duration: "40 min", tss: 60, instructions: "Warm-up 10 min. Main: 6x3 min threshold. Cool-down 10 min." },
          ],
        },
      ],
      start,
      [{ week: 1, phase: "Build" }]
    );

    const plan = await prisma.trainingPlan.findFirst({ where: { userId: user.id } });
    const planned = await prisma.plannedSession.findFirst({ where: { planId: plan!.id } });

    console.log("A session that never happened cannot be corrected:");
    let rejected = false;
    try {
      await updateExecutedSession(planned!.id, { actualTss: 30 });
    } catch {
      rejected = true;
    }
    check("editing a still-planned session is rejected", rejected);

    // Mark it done, evidenced by a Strava activity — as reconciliation would.
    const activity = await prisma.stravaActivity.create({
      data: {
        userId: user.id, stravaId: `test-${Date.now()}`,
        name: "Evening Run", discipline: "Run", sportType: "Run",
        startDate: new Date("2026-08-04T18:00:00"),
        estimatedTss: 60, movingTime: 2400, distance: 6000,
        isTrainer: false, detailsFetched: false,
      },
    });
    await prisma.plannedSession.update({
      where: { id: planned!.id },
      data: { status: "completed", actualTss: 60, sourceActivityId: activity.id },
    });

    console.log("\nThe athlete corrects it:");
    const updated = await updateExecutedSession(planned!.id, {
      actualTss: 30,
      athleteNote: "Did 3x3 instead of 6x3 — calf felt tight.",
    });
    check("actualTss is corrected", updated.actualTss === 30, String(updated.actualTss));
    check("the note is saved", updated.athleteNote === "Did 3x3 instead of 6x3 — calf felt tight.");

    const refreshedActivity = await prisma.stravaActivity.findUnique({ where: { id: activity.id } });
    check("the linked Strava activity's TSS is kept in sync — this is what the engine actually reads",
      refreshedActivity?.estimatedTss === 30, String(refreshedActivity?.estimatedTss));

    const view = await getSeasonView(user.id, new Date("2026-08-10T00:00:00"));
    const shown = view.weeks.flatMap((w) => w.sessions).find((s) => s.id === planned!.id);
    check("the season view reflects the corrected TSS", shown?.actualTss === 30, String(shown?.actualTss));
    check("the season view carries the athlete's note", shown?.athleteNote?.includes("3x3"), shown?.athleteNote ?? "null");

    console.log("\nA note-only edit does not disturb the TSS:");
    const noteOnly = await updateExecutedSession(planned!.id, { athleteNote: "Felt better by the end." });
    check("TSS is untouched when only the note changes", noteOnly.actualTss === 30, String(noteOnly.actualTss));
    check("the note is replaced", noteOnly.athleteNote === "Felt better by the end.");

    console.log("\nClearing the note:");
    const cleared = await updateExecutedSession(planned!.id, { athleteNote: "" });
    check("an empty note is stored as null, not an empty string", cleared.athleteNote === null);
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
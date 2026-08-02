/**
 * Tests for what a session's status means, and how it reaches the athlete.
 *
 * These lock three bugs that were reported from real use:
 *
 *   1. Sessions that were planned but not done were visible in the calendar.
 *      They must stay in the DATABASE (they are the intent-vs-reality
 *      baseline, v3 §2.4) but be hidden from the athlete on days they trained.
 *
 *   2. The calendar showed sessions the athlete had NOT completed as complete.
 *      Every non-planned status was treated as history, so "missed" rendered
 *      as an achievement and counted towards completed load.
 *
 *   3. Unplanned training showed 0 TSS. Reconciliation deliberately writes
 *      `tss: 0` on it — nothing was prescribed — and puts the real figure in
 *      `actualTss`. Reading `tss` alone reports work the athlete definitely
 *      did as free.
 *
 * The status rules are pure, so most of this runs with no database. The season
 * view checks use a throwaway account, removed at the end.
 *
 * Run with:  npm run test:status
 */
import "./env.mts";
import {
  didTrain,
  isUpcoming,
  isSettled,
  isGhost,
  displayTss,
  completedTss,
  hideGhosts,
} from "../lib/session-status";
import { createUser, saveFullPlan, getSeasonView, getTodayView } from "../lib/db";
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

const stamp = Date.now();

async function main() {
  console.log("\nTriApp — session status tests\n");

  let userId = "";

  try {
    console.log("Only real training counts as done:");
    check("completed counts", didTrain("completed"));
    // Under the Baseline Rule (v3 §2.4) a substituted session is a ghost:
    // the work actually done lives on its own `unplanned` row. Counting the
    // ghost too counted the day twice and, because its actualTss is null,
    // credited the athlete with the planned session they did not do.
    check("substituted does NOT count — the ghost would double-count the day",
      !didTrain("substituted"));
    check("but substituted is still settled, not upcoming",
      isSettled("substituted") && !isUpcoming("substituted"));
    check("a substituted ghost contributes no completed load",
      completedTss({ tss: 50, actualTss: null, status: "substituted" }) === 0);
    check("unplanned counts — they did train", didTrain("unplanned"));
    check("missed does NOT count", !didTrain("missed"));
    check("skipped does NOT count", !didTrain("skipped"));
    check("planned does NOT count", !didTrain("planned"));
    check("adapted does NOT count", !didTrain("adapted"));

    console.log("\nSettled is not the same as achieved:");
    check("missed is settled", isSettled("missed"));
    check("skipped is settled", isSettled("skipped"));
    check("but neither is training", !didTrain("missed") && !didTrain("skipped"));
    check("planned is still upcoming", isUpcoming("planned"));
    check("adapted is still upcoming", isUpcoming("adapted"));
    check("adapted is not settled", !isSettled("adapted"));

    console.log("\nGhosts are the sessions that did not happen:");
    check("substituted is a ghost", isGhost("substituted"));
    check("and is settled, but not an achievement", isSettled("substituted"));
    check("missed is a ghost", isGhost("missed"));
    check("completed is not a ghost", !isGhost("completed"));
    check("skipped is not a ghost — the athlete decided", !isGhost("skipped"));

    console.log("\nUnplanned training is worth what it cost:");
    // Exactly how reconcile.ts writes it: prescribed 0, actual 95.
    const unplanned = { tss: 0, actualTss: 95, status: "unplanned" };
    check("it does not display as 0 TSS", displayTss(unplanned) === 95,
      `${displayTss(unplanned)}`);
    check("and it counts as 95 completed", completedTss(unplanned) === 95);

    const over = { tss: 60, actualTss: 95, status: "completed" };
    check(
      "a session done harder than planned shows what was done",
      displayTss(over) === 95
    );
    const under = { tss: 100, actualTss: 40, status: "completed" };
    check(
      "and one done easier shows that too",
      completedTss(under) === 40,
      `${completedTss(under)}`
    );

    console.log("\nWork not done is never counted:");
    const missed = { tss: 80, actualTss: null, status: "missed" };
    check("a missed session contributes nothing", completedTss(missed) === 0);
    check(
      "but still shows its prescribed load, so the athlete sees what they lost",
      displayTss(missed) === 80
    );
    const skipped = { tss: 50, actualTss: null, status: "skipped" };
    check("a skipped session contributes nothing", completedTss(skipped) === 0);
    const planned = { tss: 70, actualTss: null, status: "planned" };
    check("an upcoming session contributes nothing", completedTss(planned) === 0);
    check("and shows its prescribed load", displayTss(planned) === 70);

    console.log("\nA reconciled session with no actual falls back honestly:");
    const noActual = { tss: 55, actualTss: null, status: "completed" };
    check(
      "it uses the prescribed figure rather than inventing one",
      displayTss(noActual) === 55
    );

    console.log("\nGhosts are hidden only where training replaced them:");
    const day = "2026-08-05";
    const withReplacement = hideGhosts([
      { id: "ghost", status: "substituted", date: day },
      { id: "real", status: "unplanned", date: day },
    ]);
    check("the ghost is hidden", !withReplacement.some((s) => s.id === "ghost"));
    check("the real session stays", withReplacement.some((s) => s.id === "real"));

    const nothingDone = hideGhosts([
      { id: "ghost", status: "missed", date: day },
    ]);
    check(
      "a missed day with no training stays visible",
      nothingDone.length === 1,
      "the athlete must know they missed it"
    );

    const otherDay = hideGhosts([
      { id: "ghost", status: "missed", date: "2026-08-05" },
      { id: "real", status: "completed", date: "2026-08-06" },
    ]);
    check(
      "training on a different day does not hide it",
      otherDay.length === 2
    );

    // ---- Against the database ------------------------------------------
    const user = await createUser(`status-${stamp}@test.local`, "pw");
    userId = user.id;

    const start = new Date(2026, 7, 3); // Monday 3 Aug 2026
    await saveFullPlan(
      userId,
      new Date(2026, 8, 13),
      [
        {
          week: 1,
          phase: "Base",
          summary: "Aerobic base",
          sessions: [
            { day: "Monday", discipline: "Swim", type: "Endurance",
              duration: "45 min", tss: 40, instructions: "", pace: "" },
            { day: "Tuesday", discipline: "Run", type: "Tempo",
              duration: "40 min", tss: 90, instructions: "", pace: "" },
            { day: "Wednesday", discipline: "Bike", type: "Endurance",
              duration: "60 min", tss: 60, instructions: "", pace: "" },
          ],
        },
      ],
      start
    );

    const plan = await prisma.trainingPlan.findFirst({
      where: { userId },
      include: { sessions: true },
    });
    const swim = plan!.sessions.find((s) => s.discipline === "Swim")!;
    const run = plan!.sessions.find((s) => s.discipline === "Run")!;
    const bike = plan!.sessions.find((s) => s.discipline === "Bike")!;

    // Monday: they swam as planned, harder than prescribed.
    await prisma.plannedSession.update({
      where: { id: swim.id },
      data: { status: "completed", actualTss: 55 },
    });
    // Tuesday: they ran nothing — a genuine miss, nothing else that day.
    await prisma.plannedSession.update({
      where: { id: run.id },
      data: { status: "missed", actualTss: null },
    });
    // Wednesday: planned a bike, actually ran. Ghost + the real activity.
    await prisma.plannedSession.update({
      where: { id: bike.id },
      data: { status: "substituted", actualTss: null },
    });
    await prisma.plannedSession.create({
      data: {
        planId: plan!.id,
        week: 1,
        day: "Wednesday",
        scheduledDate: new Date(2026, 7, 5),
        discipline: "Run",
        type: "Unplanned",
        duration: "50 min",
        tss: 0,
        actualTss: 70,
        status: "unplanned",
        completedAt: new Date(2026, 7, 5),
        sourceActivityId: `mock-${stamp}`,
      },
    });

    const season = await getSeasonView(userId, new Date(2026, 7, 6));
    const w1 = season.weeks.find((w) => w.week === 1)!;
    const ids = w1.sessions.map((s) => s.id);

    console.log("\nThe calendar hides ghosts but keeps the record:");
    check(
      "the substituted bike is hidden from the calendar",
      !ids.includes(bike.id)
    );
    check(
      "but it is still in the database as the baseline",
      (await prisma.plannedSession.findUnique({ where: { id: bike.id } }))
        ?.status === "substituted"
    );
    check(
      "the run they actually did is shown",
      w1.sessions.some((s) => s.status === "unplanned")
    );
    check(
      "the missed run stays visible — nothing replaced it",
      ids.includes(run.id),
      w1.sessions.map((s) => `${s.discipline}:${s.status}`).join(", ")
    );

    console.log("\nThe calendar reports honest load:");
    const unplannedRow = w1.sessions.find((s) => s.status === "unplanned")!;
    check(
      "unplanned training exposes its actual TSS, not 0",
      unplannedRow.actualTss === 70,
      `${unplannedRow.actualTss}`
    );
    check(
      "and its prescribed TSS is honestly 0",
      unplannedRow.tss === 0
    );
    check(
      "so it displays as 70, not 0",
      displayTss(unplannedRow) === 70,
      `${displayTss(unplannedRow)}`
    );

    const completedSwim = w1.sessions.find((s) => s.id === swim.id)!;
    check(
      "a harder-than-planned swim reports what was actually done",
      displayTss(completedSwim) === 55
    );

    const missedRun = w1.sessions.find((s) => s.id === run.id)!;
    check("the missed run counts as 0 completed", completedTss(missedRun) === 0);

    // The reported bug in its purest form: the athlete planned a 60 TSS bike,
    // rode nothing, and ran instead. The bike must contribute nothing.
    const ghostBike = await prisma.plannedSession.findUnique({
      where: { id: bike.id },
    });
    check(
      "the substituted bike is worth 0, not its prescribed 60",
      completedTss({
        tss: ghostBike!.tss,
        actualTss: ghostBike!.actualTss,
        status: ghostBike!.status,
      }) === 0
    );

    const weekDone = w1.sessions.reduce((n, s) => n + completedTss(s), 0);
    check(
      "the week's completed load is swim 55 + run 70 = 125",
      weekDone === 125,
      `${weekDone}`
    );
    check(
      "the missed session is NOT in that figure",
      weekDone < w1.sessions.reduce((n, s) => n + s.tss + (s.actualTss ?? 0), 0)
    );

    console.log("\nToday agrees with the calendar:");
    const wed = await getTodayView(userId, new Date(2026, 7, 5));
    check(
      "Today hides the same ghost",
      !wed.sessions.some((s) => s.id === bike.id)
    );
    check(
      "and shows the same real session",
      wed.sessions.some((s) => s.status === "unplanned")
    );

    console.log("\nCleanup:");
    await prisma.user.delete({ where: { id: userId } });
    userId = "";
    check("the test account is removed", true);
  } finally {
    if (userId) {
      await prisma.user.delete({ where: { id: userId } }).catch(() => {});
    }
    await prisma.$disconnect();
  }

  console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Test run crashed:", err);
  process.exit(1);
});

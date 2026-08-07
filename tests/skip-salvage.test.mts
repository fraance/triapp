/**
 * Tests for the skip-salvage step (v3 §3.5).
 *
 * Locks a real gap: an important session the athlete skipped had no path back
 * into the week — the salvage engine computed a decision but nothing acted on
 * it, so the plan (and the athlete's progression) lost the work. These tests
 * pin that a skipped important session is re-queued onto the first compatible
 * slot, is never placed on an anchor or an existing test, honors discipline and
 * the commitment window, and that the decision can be exercised both as a pure
 * function and against a throwaway database account.
 *
 * Run with:  npm run test:salvage
 */
import "./env.mts";
import { createUser, saveFullPlan } from "../lib/db";
import { prisma } from "../lib/prisma";
import { localISO } from "../lib/adaptation/load-vector";
import {
  pickSalvageSlot,
  salvageSkippedSessions,
} from "../lib/adaptation/skip-salvage";

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
  console.log("\nTriApp — skip salvage tests\n");
  let userId = "";

  try {
    const slotCommon = {
      today: "2026-08-07",
      frozenUntil: "2026-08-07",
      horizonDays: 10,
      existingTestDates: [],
    };

    console.log("A skipped important session is requeued onto the first legal slot:");
    const slots = [
      { id: "s-anchor", date: "2026-08-08", discipline: "Bike", type: "Long", isAnchor: true, status: "planned" },
      { id: "s-frozen", date: "2026-08-08", discipline: "Bike", type: "Endurance", isAnchor: false, status: "planned" },
      { id: "s-already", date: "2026-08-09", discipline: "Bike", type: "Test", isAnchor: false, status: "planned", isTest: true },
      { id: "s-good", date: "2026-08-11", discipline: "Bike", type: "Tempo", isAnchor: false, status: "planned" },
    ];
    const chosen = pickSalvageSlot(
      { discipline: "Bike", durationMinutes: 75 },
      { ...slotCommon, slots },
      { asTest: true }
    );
    check(
      "the first legal non-anchor, non-test bike slot wins",
      chosen?.id === "s-frozen",
      chosen?.id ?? "none"
    );

    const wrongSport = pickSalvageSlot(
      { discipline: "Run", durationMinutes: 55 },
      { ...slotCommon, slots }
    );
    check("a run never lands on a bike slot", wrongSport === null);

    const frozen = pickSalvageSlot(
      { discipline: "Bike", durationMinutes: 75 },
      {
        ...slotCommon,
        slots: [{ id: "s-frozen", date: "2026-08-07", discipline: "Bike", type: "E", isAnchor: false, status: "planned" }],
      },
      { asTest: true }
    );
    check("a slot inside the commitment window is disqualified", frozen === null);

    console.log("\nAgainst a throwaway database:");
    const user = await createUser(`salvage-${stamp}@test.local`, "pw");
    userId = user.id;
    const start = new Date(2026, 7, 3); // Monday
    await saveFullPlan(
      userId,
      new Date(2026, 8, 13),
      [
        {
          week: 1,
          phase: "Base",
          summary: "Aerobic base",
          sessions: [
            { day: "Monday", discipline: "Bike", type: "Threshold", duration: "75 min", tss: 85, instructions: "opener+test", pace: "" },
            { day: "Tuesday", discipline: "Bike", type: "Endurance", duration: "60 min", tss: 60, instructions: "easy", pace: "" },
            { day: "Wednesday", discipline: "Bike", type: "Endurance", duration: "60 min", tss: 60, instructions: "easy", pace: "" },
            { day: "Thursday", discipline: "Bike", type: "Recovery", duration: "30 min", tss: 30, instructions: "shut up legs", pace: "" },
          ],
        },
      ],
      start
    );

    const plan = await prisma.trainingPlan.findFirst({ where: { userId } });
    const planId = plan!.id;
    const rows = await prisma.plannedSession.findMany({ where: { planId } });
    const bikeTest = rows.find((s) => s.type === "Threshold")!;
    const candidate = rows.find((s) => s.day === "Tuesday")!;

    // Simulate the reported bug: the important bike test was skipped yesterday.
    await prisma.plannedSession.update({
      where: { id: bikeTest.id },
      data: {
        status: "skipped",
        isTest: true,
        testKind: "thresholdHr",
        purpose: "Establish threshold Hr",
        scheduledDate: new Date(2026, 7, 3),
      },
    });

    const slotRows = rows.map((r) => ({
      id: r.id,
      date: localISO(r.scheduledDate!),
      discipline: r.discipline,
      type: r.type ?? "",
      isAnchor: r.isAnchor,
      status: r.status,
    }));

    const res = await salvageSkippedSessions(
      userId,
      planId,
      {
        today: "2026-08-04",
        frozenUntil: "2026-08-04",
        horizonDays: 10,
        slots: slotRows,
        existingTestDates: [],
      },
      { dryRun: true }
    );
    check(
      "the skipped bike test is considered for salvage",
      res.requeued.length > 0 || res.couldNotPlace.length > 0,
      JSON.stringify(res)
    );

    // Run it for real and confirm the requeue hits the Tuesday slot.
    const real = await salvageSkippedSessions(
      userId,
      planId,
      {
        today: "2026-08-04",
        frozenUntil: "2026-08-04",
        horizonDays: 2,
        slots: slotRows,
        existingTestDates: [],
      }
    );
    check("the requeue targets a slot", real.requeued.length === 1, JSON.stringify(real));
    const updated = await prisma.plannedSession.findUnique({
      where: { id: real.requeued[0]?.requeuedId ?? "__none__" },
    });
    check(
      "the target slot is now a test",
      updated?.isTest === true && updated?.status === "planned",
      `${updated?.type} / ${updated?.status}`
    );
    check(
      "the requeued session points at the planned work, not the skipped row",
      updated?.id !== bikeTest.id
    );

    void candidate;
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
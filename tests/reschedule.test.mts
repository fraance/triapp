/**
 * Tests for manual rescheduling — dragging a session to a different day.
 *
 * What must hold:
 *   1. week / day / scheduledDate always agree after a move. A session can
 *      never be in two places depending on which screen you look at.
 *   2. The commitment window belongs to the ENGINE, not the athlete. It stops
 *      the coach reshuffling imminent days by itself; v3 §4.4 allows a manual
 *      override, and today is not the past. What the athlete may never do is
 *      schedule a session into a day that has already gone.
 *   3. A batch is all-or-nothing. One illegal move writes nothing.
 *   4. Records of what actually happened (completed, skipped, substituted) are
 *      not reschedulable.
 *   5. Guardrail breaches warn but never block — the athlete stays in charge.
 *   6. Every save is snapshotted and logged, so a manual move is as auditable
 *      as an automatic one.
 *   7. The season view exposes what the calendar needs, and reflects moves.
 *
 * Runs against throwaway accounts only, cleaned up at the end.
 *
 * Run with:  npm run test:reschedule
 */
import "./env.mts";
import {
  createUser,
  saveFullPlan,
  getSeasonView,
  getTodayView,
} from "../lib/db";
import {
  applyMoves,
  warningsFor,
  slotFor,
  freezeBoundary,
  isoDate,
  parseISODate,
  nominalDate,
} from "../lib/reschedule";
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
  console.log("\nTriApp — manual rescheduling tests\n");

  let userId = "";

  try {
    // ---- Pure date logic, no database ----------------------------------
    console.log("The commitment window:");
    // 2026-08-05 is a Wednesday.
    const midday = new Date(2026, 7, 5, 12, 0);
    const evening = new Date(2026, 7, 5, 20, 30);
    check(
      "before 20:00 only today is committed",
      freezeBoundary(midday) === "2026-08-05",
      freezeBoundary(midday)
    );
    check(
      "from 20:00 tomorrow is committed too",
      freezeBoundary(evening) === "2026-08-06",
      freezeBoundary(evening)
    );
    check(
      "19:59 has not yet locked tomorrow",
      freezeBoundary(new Date(2026, 7, 5, 19, 59)) === "2026-08-05"
    );

    console.log("\nDates are local, never UTC:");
    check(
      "a date parses back to itself",
      isoDate(parseISODate("2026-08-05")!) === "2026-08-05"
    );
    check("a malformed date is rejected", parseISODate("5 August") === null);
    check("an empty date is rejected", parseISODate("") === null);

    console.log("\nweek / day / date are derived together:");
    // Plan starts Monday 2026-08-03.
    const planStart = new Date(2026, 7, 3);
    const wed1 = slotFor(planStart, new Date(2026, 7, 5));
    check("Wednesday of week 1 is week 1", wed1.week === 1, `${wed1.week}`);
    check("and is named Wednesday", wed1.day === "Wednesday", wed1.day);

    const sun1 = slotFor(planStart, new Date(2026, 7, 9));
    check(
      "Sunday belongs to the week that started on Monday",
      sun1.week === 1 && sun1.day === "Sunday",
      `week ${sun1.week}, ${sun1.day}`
    );

    const mon2 = slotFor(planStart, new Date(2026, 7, 10));
    check(
      "the next Monday starts week 2",
      mon2.week === 2 && mon2.day === "Monday",
      `week ${mon2.week}, ${mon2.day}`
    );

    check(
      "a week/day pair maps back to the same calendar day",
      isoDate(nominalDate(planStart, 2, "Thursday")) === "2026-08-13",
      isoDate(nominalDate(planStart, 2, "Thursday"))
    );

    // ---- Guardrail warnings, pure ---------------------------------------
    console.log("\nGuardrails warn about placement:");
    const clean = warningsFor([
      {
        id: "a",
        date: "2026-08-05",
        discipline: "Run",
        type: "Tempo",
        tss: 90,
        isAnchor: true,
        status: "planned",
      },
      {
        id: "b",
        date: "2026-08-09",
        discipline: "Bike",
        type: "Endurance",
        tss: 40,
        isAnchor: false,
        status: "planned",
      },
    ]);
    check("a well-spread week warns about nothing", clean.length === 0,
      clean.map((w) => w.rule).join(", "));

    const stacked = warningsFor([
      {
        id: "a",
        date: "2026-08-05",
        discipline: "Run",
        type: "Tempo",
        tss: 95,
        isAnchor: true,
        status: "planned",
      },
      {
        id: "b",
        date: "2026-08-05",
        discipline: "Bike",
        type: "Threshold",
        tss: 95,
        isAnchor: true,
        status: "planned",
      },
    ]);
    check(
      "two key sessions on one day is flagged",
      stacked.some((w) => w.rule === "same_day_separation"),
      stacked.map((w) => w.rule).join(", ") || "no warnings"
    );
    check(
      "the warning says something the athlete can act on",
      stacked.every((w) => w.detail.length > 10)
    );
    check(
      "and names the day, so the calendar can mark it",
      stacked.some((w) => w.dates.includes("2026-08-05")),
      JSON.stringify(stacked.map((w) => w.dates))
    );

    const completedStack = warningsFor([
      {
        id: "a",
        date: "2026-08-05",
        discipline: "Run",
        type: "Tempo",
        tss: 95,
        isAnchor: true,
        status: "completed",
      },
      {
        id: "b",
        date: "2026-08-05",
        discipline: "Bike",
        type: "Threshold",
        tss: 95,
        isAnchor: true,
        status: "completed",
      },
    ]);
    check(
      "training already done is not warned about",
      completedStack.length === 0
    );

    // ---- Database-backed ------------------------------------------------
    const user = await createUser(`reschedule-${stamp}@test.local`, "pw");
    userId = user.id;

    // Plan starting well in the future so nothing is inside the freeze window.
    const start = new Date(2026, 7, 3); // Monday 3 Aug 2026
    const race = new Date(2026, 8, 13);
    await saveFullPlan(
      userId,
      race,
      [
        {
          week: 1,
          phase: "Base",
          summary: "Aerobic base",
          sessions: [
            {
              day: "Monday",
              discipline: "Swim",
              type: "Endurance",
              duration: "45 min",
              tss: 40,
              instructions: "10x100m",
              pace: "1:45/100m",
            },
            {
              day: "Wednesday",
              discipline: "Run",
              type: "Tempo",
              duration: "40 min",
              tss: 90,
              instructions: "20 min threshold",
              pace: "4:30/km",
            },
            {
              day: "Saturday",
              discipline: "Bike",
              type: "Long",
              duration: "120 min",
              tss: 100,
              instructions: "Zone 2",
              pace: "Zone 2",
            },
          ],
        },
        {
          week: 2,
          phase: "Base",
          summary: "Building",
          sessions: [
            {
              day: "Tuesday",
              discipline: "Run",
              type: "Endurance",
              duration: "50 min",
              tss: 55,
              instructions: "Easy",
              pace: "5:30/km",
            },
          ],
        },
      ],
      start
    );

    const plan = await prisma.trainingPlan.findFirst({
      where: { userId },
      include: { sessions: true },
    });
    const runWed = plan!.sessions.find(
      (s) => s.discipline === "Run" && s.week === 1
    )!;
    const swimMon = plan!.sessions.find((s) => s.discipline === "Swim")!;
    const bikeSat = plan!.sessions.find((s) => s.discipline === "Bike")!;

    console.log("\nThe season view gives the calendar what it needs:");
    const before = await getSeasonView(userId, new Date(2026, 7, 4));
    const w1 = before.weeks.find((w) => w.week === 1)!;
    check("sessions carry an id", w1.sessions.every((s) => !!s.id));
    check(
      "sessions carry a real calendar date",
      w1.sessions.every((s) => /^\d{4}-\d{2}-\d{2}$/.test(s.date))
    );
    check("sessions carry their status", w1.sessions.every((s) => !!s.status));
    check(
      "the view says how far the commitment window reaches",
      before.frozenUntil === "2026-08-04",
      before.frozenUntil
    );
    check(
      "week 1 starts on the Monday",
      w1.startDate === "2026-08-03",
      w1.startDate ?? "null"
    );
    check(
      "the Wednesday run is dated Wednesday",
      w1.sessions.find((s) => s.discipline === "Run")?.date === "2026-08-05"
    );
    check(
      "sessions come back in date order",
      w1.sessions.map((s) => s.date).join() ===
        [...w1.sessions.map((s) => s.date)].sort().join()
    );

    console.log("\nMoving a session within a week:");
    // "Now" is well before the plan, so nothing is frozen.
    const now = new Date(2026, 6, 1, 9, 0);
    const moved = await applyMoves(
      userId,
      [{ sessionId: runWed.id, toDate: "2026-08-07" }],
      now
    );
    check("the move is applied", moved.applied === true, JSON.stringify(moved.rejected));
    check("one session moved", moved.moved === 1);

    const afterRow = await prisma.plannedSession.findUnique({
      where: { id: runWed.id },
    });
    check(
      "scheduledDate is updated",
      isoDate(afterRow!.scheduledDate!) === "2026-08-07",
      afterRow!.scheduledDate ? isoDate(afterRow!.scheduledDate) : "null"
    );
    check("day is updated to match", afterRow!.day === "Friday", afterRow!.day);
    check("week stays correct", afterRow!.week === 1, `${afterRow!.week}`);
    check(
      "the three position fields agree",
      isoDate(nominalDate(start, afterRow!.week, afterRow!.day)) ===
        isoDate(afterRow!.scheduledDate!)
    );

    console.log("\nMoving a session across a week boundary:");
    const crossed = await applyMoves(
      userId,
      [{ sessionId: swimMon.id, toDate: "2026-08-11" }],
      now
    );
    check("the move is applied", crossed.applied === true);
    const swimRow = await prisma.plannedSession.findUnique({
      where: { id: swimMon.id },
    });
    check(
      "week is recalculated, not left stale",
      swimRow!.week === 2,
      `week ${swimRow!.week}`
    );
    check("day is recalculated", swimRow!.day === "Tuesday", swimRow!.day);

    const afterCross = await getSeasonView(userId, new Date(2026, 7, 4));
    check(
      "the season view shows it in week 2",
      afterCross.weeks
        .find((w) => w.week === 2)!
        .sessions.some((s) => s.id === swimMon.id)
    );
    check(
      "and no longer in week 1",
      !afterCross.weeks
        .find((w) => w.week === 1)!
        .sessions.some((s) => s.id === swimMon.id)
    );

    console.log("\nThe athlete may override the commitment window:");
    // Pretend it is Friday 7 Aug, mid-morning. The engine treats 2026-08-07 as
    // committed and will not reshuffle it; the athlete still can.
    const onTheDay = new Date(2026, 7, 7, 10, 0);
    const movedToday = await applyMoves(
      userId,
      [{ sessionId: runWed.id, toDate: "2026-08-10" }],
      onTheDay
    );
    check(
      "today's own session can be moved by hand",
      movedToday.applied === true,
      JSON.stringify(movedToday.rejected)
    );

    const ontoToday = await applyMoves(
      userId,
      [{ sessionId: bikeSat.id, toDate: "2026-08-07" }],
      onTheDay
    );
    check(
      "and something can be moved onto today",
      ontoToday.applied === true,
      JSON.stringify(ontoToday.rejected)
    );
    // Put it back for the checks that follow.
    await applyMoves(userId, [{ sessionId: bikeSat.id, toDate: "2026-08-08" }], onTheDay);

    const intoThePast = await applyMoves(
      userId,
      [{ sessionId: bikeSat.id, toDate: "2026-08-05" }],
      onTheDay
    );
    check(
      "but nothing can be scheduled into a day that has gone",
      intoThePast.applied === false && intoThePast.rejected.length === 1
    );
    check(
      "and the athlete is told why",
      /passed|past/i.test(intoThePast.rejected[0]?.reason ?? ""),
      intoThePast.rejected[0]?.reason
    );

    console.log("\nA batch is all or nothing:");
    const bikeBefore = await prisma.plannedSession.findUnique({
      where: { id: bikeSat.id },
    });
    const mixed = await applyMoves(
      userId,
      [
        { sessionId: bikeSat.id, toDate: "2026-08-09" }, // legal
        { sessionId: runWed.id, toDate: "2026-08-01" }, // into the past
      ],
      onTheDay
    );
    check("the batch is refused", mixed.applied === false);
    const bikeAfter = await prisma.plannedSession.findUnique({
      where: { id: bikeSat.id },
    });
    check(
      "the legal move in the batch was NOT written",
      String(bikeBefore!.scheduledDate) === String(bikeAfter!.scheduledDate) &&
        bikeBefore!.day === bikeAfter!.day
    );

    console.log("\nHistory cannot be rescheduled:");
    await prisma.plannedSession.update({
      where: { id: bikeSat.id },
      data: { status: "completed" },
    });
    const historic = await applyMoves(
      userId,
      [{ sessionId: bikeSat.id, toDate: "2026-08-09" }],
      now
    );
    check("a completed session is refused", historic.applied === false);
    check(
      "and the reason explains it is a record",
      /record/i.test(historic.rejected[0]?.reason ?? ""),
      historic.rejected[0]?.reason
    );
    await prisma.plannedSession.update({
      where: { id: bikeSat.id },
      data: { status: "planned" },
    });

    console.log("\nSomeone else's session is not moveable:");
    const other = await createUser(`reschedule-other-${stamp}@test.local`, "pw");
    const stolen = await applyMoves(
      other.id,
      [{ sessionId: runWed.id, toDate: "2026-08-09" }],
      now
    );
    check("the move is refused", stolen.applied === false);
    await prisma.user.delete({ where: { id: other.id } }).catch(() => {});

    console.log("\nA move is visible on the Today screen:");
    // The Saturday bike currently sits on 2026-08-08. Move it to the 9th and
    // check Today on the 9th picks it up. Today reads dates, not week/day, so
    // this is the test that would catch the two drifting apart.
    // Make sure it starts somewhere other than Sunday, whatever earlier
    // checks did to it, so this test asserts the move and not the setup.
    await applyMoves(userId, [{ sessionId: bikeSat.id, toDate: "2026-08-08" }], now);
    const beforeToday = await getTodayView(userId, new Date(2026, 7, 9));
    check(
      "the bike is not on Sunday to begin with",
      !beforeToday.sessions.some((s) => s.id === bikeSat.id)
    );
    await applyMoves(userId, [{ sessionId: bikeSat.id, toDate: "2026-08-09" }], now);
    const afterToday = await getTodayView(userId, new Date(2026, 7, 9));
    check(
      "after moving it, Today shows it",
      afterToday.sessions.some((s) => s.id === bikeSat.id),
      afterToday.sessions.map((s) => s.discipline).join(", ") || "nothing"
    );
    check(
      "and it reports the week it actually sits in",
      afterToday.sessions.find((s) => s.id === bikeSat.id)?.week === 1
    );

    console.log("\nGuardrails warn but never block:");
    // Put the bike onto the same day as the run, wherever it now sits: both
    // are key sessions, which the guardrails dislike.
    const risky = await applyMoves(
      userId,
      [{ sessionId: bikeSat.id, toDate: "2026-08-10" }],
      now
    );
    check("the athlete's choice is still applied", risky.applied === true);
    check(
      "but they are warned",
      risky.warnings.length > 0,
      JSON.stringify(risky.warnings)
    );

    console.log("\nEvery save is auditable:");
    const versions = await prisma.planVersion.findMany({
      where: { planId: plan!.id },
      orderBy: { version: "asc" },
    });
    check("the plan was snapshotted before each write", versions.length >= 3);
    check(
      "version numbers increment",
      versions.map((v) => v.version).join() ===
        versions.map((_, i) => i + 1).join()
    );

    const log = await prisma.adaptation.findMany({
      where: { planId: plan!.id, trigger: "manual_drag" },
    });
    check("manual moves are written to the adaptation log", log.length >= 3);
    check(
      "the log records where each session came from and went",
      log.every((a) => {
        const diff = a.diff as any;
        return (
          Array.isArray(diff?.moved) &&
          diff.moved.every((m: any) => m.from && m.to && m.id)
        );
      })
    );
    check(
      "the log explains the change in plain language",
      log.every((a) => (a.explanation ?? "").length > 10)
    );
    check(
      "the log is attributed to the athlete, not the engine",
      log.every((a) => (a.cause as any)?.movedBy === "athlete")
    );

    console.log("\nNothing to do is not an error:");
    const empty = await applyMoves(userId, [], now);
    check("an empty batch does nothing", empty.applied === false && empty.moved === 0);
    check("and reports no rejections", empty.rejected.length === 0);

    console.log("\nA user with no plan:");
    const planless = await createUser(`reschedule-none-${stamp}@test.local`, "pw");
    const noPlan = await applyMoves(
      planless.id,
      [{ sessionId: "whatever", toDate: "2026-08-09" }],
      now
    );
    check("is refused rather than crashing", noPlan.applied === false);
    await prisma.user.delete({ where: { id: planless.id } }).catch(() => {});

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

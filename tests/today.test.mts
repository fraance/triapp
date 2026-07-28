/**
 * Automated tests for the "Today" screen.
 *
 * Verifies that:
 *   1. Plan days ("Week 2, Wednesday") map to the correct real calendar dates.
 *   2. The Today view returns the right session for a given day.
 *   3. Rest days (no session scheduled) are handled.
 *   4. Tomorrow's preview is correct.
 *   5. Weekly TSS totals and race countdown are correct.
 *   6. Marking a session completed/skipped persists and updates weekly load.
 *   7. A user cannot modify another user's session.
 *
 * Run with:  npm run test:today
 */
import "./env.mts";
import {
  createUser,
  saveFullPlan,
  getTodayView,
  updateSessionStatus,
  sessionBelongsToUser,
} from "../lib/db";
import {
  mondayOfWeek,
  sessionDate,
  dayNameToIndex,
  weekNumberFor,
  daysBetween,
} from "../lib/plan-dates";
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

function iso(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

async function main() {
  console.log("\nTriApp — Today screen tests\n");

  // ---- Pure date logic (no database) ------------------------------------
  console.log("Date mapping:");
  // Wednesday 2026-07-29 -> Monday of that week is 2026-07-27
  check(
    "Monday of a mid-week date is correct",
    iso(mondayOfWeek(new Date(2026, 6, 29))) === "2026-07-27",
    iso(mondayOfWeek(new Date(2026, 6, 29)))
  );
  // Sunday belongs to the week that started the previous Monday
  check(
    "Sunday maps back to the correct Monday",
    iso(mondayOfWeek(new Date(2026, 7, 2))) === "2026-07-27",
    iso(mondayOfWeek(new Date(2026, 7, 2)))
  );
  check("day names map to indexes", dayNameToIndex("Monday") === 0);
  check("day names are case-insensitive", dayNameToIndex("wednesday") === 2);
  check("invalid day names are rejected", dayNameToIndex("Funday") === -1);

  const start = new Date(2026, 6, 27); // Monday 27 Jul 2026
  check(
    "week 1 Monday = plan start date",
    iso(sessionDate(start, 1, "Monday")!) === "2026-07-27"
  );
  check(
    "week 1 Sunday = start + 6 days",
    iso(sessionDate(start, 1, "Sunday")!) === "2026-08-02"
  );
  check(
    "week 2 Wednesday = start + 9 days",
    iso(sessionDate(start, 2, "Wednesday")!) === "2026-08-05"
  );
  check(
    "week 3 Friday = start + 18 days",
    iso(sessionDate(start, 3, "Friday")!) === "2026-08-14"
  );
  check("week number for start date is 1", weekNumberFor(start, start) === 1);
  check(
    "week number 10 days in is 2",
    weekNumberFor(start, new Date(2026, 7, 6)) === 2
  );
  check(
    "days between two dates is correct",
    daysBetween(start, new Date(2026, 7, 2)) === 6
  );

  // ---- Database-backed Today view ---------------------------------------
  const email = `today_${Date.now()}@triapp.test`;
  const otherEmail = `other_${Date.now()}@triapp.test`;
  let userId = "";
  let otherUserId = "";

  try {
    const user = await createUser(email, "pw123456");
    userId = user.id;
    const other = await createUser(otherEmail, "pw123456");
    otherUserId = other.id;

    // Plan starting Monday 27 Jul 2026, race 30 Aug 2026
    const planStart = new Date(2026, 6, 27);
    const raceDate = new Date(2026, 7, 30);

    await saveFullPlan(
      userId,
      raceDate,
      [
        {
          week: 1,
          phase: "Base Building",
          summary: "Aerobic base week",
          sessions: [
            {
              day: "Monday",
              discipline: "Swim",
              type: "Endurance",
              duration: "45 min",
              tss: 100,
              instructions: "10x100m steady",
              pace: "1:45/100m",
            },
            {
              day: "Wednesday",
              discipline: "Run",
              type: "Tempo",
              duration: "40 min",
              tss: 150,
              instructions: "20 min at threshold",
              pace: "4:30/km",
            },
            // Note: no Tuesday session -> Tuesday is a rest day
            {
              day: "Sunday",
              discipline: "Bike",
              type: "Long",
              duration: "120 min",
              tss: 200,
              instructions: "Zone 2 endurance",
              pace: "Zone 2",
            },
          ],
        },
        {
          week: 2,
          phase: "Build",
          summary: "Intensity increases",
          sessions: [
            {
              day: "Monday",
              discipline: "Run",
              type: "Intervals",
              duration: "50 min",
              tss: 180,
              instructions: "6x800m",
              pace: "4:00/km",
            },
          ],
        },
      ],
      planStart
    );

    console.log("\nToday view — a day with a session:");
    // Monday 27 Jul = week 1 Monday -> Swim
    const monday = await getTodayView(userId, new Date(2026, 6, 27));
    check("has a plan", monday.hasPlan === true);
    check("is inside the plan range", monday.inPlanRange === true);
    check("reports the correct week", monday.week === 1, `got ${monday.week}`);
    check("reports the week phase", monday.phase === "Base Building");
    check("returns exactly one session", monday.sessions.length === 1);
    check(
      "returns the correct discipline",
      monday.sessions[0]?.discipline === "Swim",
      monday.sessions[0]?.discipline
    );
    check(
      "session carries its instructions",
      monday.sessions[0]?.instructions === "10x100m steady"
    );
    check("session starts as 'planned'", monday.sessions[0]?.status === "planned");
    check(
      "weekly planned TSS is the sum of the week",
      monday.weekTssPlanned === 450,
      `got ${monday.weekTssPlanned}`
    );
    check(
      "completed TSS starts at zero",
      monday.weekTssCompleted === 0
    );
    check(
      "race countdown is correct",
      monday.daysUntilRace === 34,
      `got ${monday.daysUntilRace}`
    );

    console.log("\nTomorrow preview:");
    check(
      "Monday shows no session for Tuesday (rest day)",
      monday.tomorrow.length === 0
    );
    // Tuesday 28 Jul -> rest day, tomorrow (Wed) = Run
    const tuesday = await getTodayView(userId, new Date(2026, 6, 28));
    check("Tuesday is a rest day (no sessions)", tuesday.sessions.length === 0);
    check(
      "Tuesday correctly previews Wednesday's Run",
      tuesday.tomorrow[0]?.discipline === "Run",
      tuesday.tomorrow[0]?.discipline
    );

    console.log("\nWeek boundaries:");
    // Sunday 2 Aug = still week 1 -> Bike
    const sunday = await getTodayView(userId, new Date(2026, 7, 2));
    check("Sunday is still week 1", sunday.week === 1, `got ${sunday.week}`);
    check(
      "Sunday returns the long Bike session",
      sunday.sessions[0]?.discipline === "Bike"
    );
    // Monday 3 Aug = week 2 -> Run intervals
    const week2 = await getTodayView(userId, new Date(2026, 7, 3));
    check("next Monday rolls into week 2", week2.week === 2, `got ${week2.week}`);
    check(
      "week 2 returns the correct session",
      week2.sessions[0]?.type === "Intervals"
    );
    check("week 2 phase is reported", week2.phase === "Build");

    console.log("\nOutside the plan range:");
    const before = await getTodayView(userId, new Date(2026, 6, 20));
    check("a date before the plan is flagged out of range", before.inPlanRange === false);
    const after = await getTodayView(userId, new Date(2026, 9, 1));
    check("a date after the plan is flagged out of range", after.inPlanRange === false);

    console.log("\nMarking sessions done:");
    const swimId = monday.sessions[0].id;
    await updateSessionStatus(swimId, "completed", undefined, new Date());
    const afterComplete = await getTodayView(userId, new Date(2026, 6, 27));
    check(
      "session status becomes 'completed'",
      afterComplete.sessions[0].status === "completed"
    );
    check(
      "completed TSS now counts toward the week",
      afterComplete.weekTssCompleted === 100,
      `got ${afterComplete.weekTssCompleted}`
    );

    await updateSessionStatus(swimId, "skipped");
    const afterSkip = await getTodayView(userId, new Date(2026, 6, 27));
    check("session can be marked 'skipped'", afterSkip.sessions[0].status === "skipped");
    check(
      "skipped sessions do not count as completed load",
      afterSkip.weekTssCompleted === 0
    );

    await updateSessionStatus(swimId, "planned");
    const afterUndo = await getTodayView(userId, new Date(2026, 6, 27));
    check("status can be reset to 'planned'", afterUndo.sessions[0].status === "planned");

    console.log("\nSecurity:");
    check(
      "a session is recognised as belonging to its owner",
      (await sessionBelongsToUser(swimId, userId)) === true
    );
    check(
      "another user cannot claim someone else's session",
      (await sessionBelongsToUser(swimId, otherUserId)) === false
    );

    console.log("\nUser with no plan:");
    const noPlan = await getTodayView(otherUserId, new Date(2026, 6, 27));
    check("a user without a plan reports hasPlan = false", noPlan.hasPlan === false);
    check("and returns no sessions", noPlan.sessions.length === 0);
  } finally {
    for (const id of [userId, otherUserId]) {
      if (id) await prisma.user.delete({ where: { id } }).catch(() => {});
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

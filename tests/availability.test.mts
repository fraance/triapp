/**
 * Tests for time availability vs physical capacity.
 *
 * The two must never be conflated:
 *   1. Availability is user input only — never derived from training volume.
 *   2. Capacity is derived from what the athlete has actually done.
 *   3. The plan targets whichever limit is TIGHTER, and says which.
 *   4. Per-day availability is respected, not just a weekly total.
 *   5. Facility constraints reach the coach.
 *
 * Run with:  npm run test:availability
 */
import "./env.mts";
import { createUser } from "../lib/db";
import { storeActivities, saveStravaToken } from "../lib/strava-db";
import {
  getAvailability,
  saveAvailability,
  getCapacity,
  getTrainingBudget,
  formatBudgetForPrompt,
  SAFE_RAMP_RATE,
} from "../lib/availability";
import { prefillAthleteProfile } from "../lib/prefill";
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

const daysAgo = (n: number) =>
  new Date(Date.now() - n * 24 * 3600 * 1000).toISOString();

async function main() {
  console.log("\nTriApp — availability vs capacity\n");

  const email = `avail_${Date.now()}@triapp.test`;
  let userId = "";

  try {
    userId = (await createUser(email, "pw123456")).id;

    console.log("Before the athlete tells us anything:");
    let budget = await getTrainingBudget(userId);
    check("availability is not set", budget.availability.isSet === false);
    check("no capacity data yet", budget.capacity.hasData === false);
    check("the limit is unknown", budget.bindingConstraint === "unknown");
    check("no weekly target is invented", budget.recommendedWeeklyHours === null);
    check(
      "the coach is told to ask",
      budget.explanation.toLowerCase().includes("ask them")
    );

    console.log("\nTraining volume must NOT become 'available time':");
    // Someone training only 4 h/week — that says nothing about their free time.
    await storeActivities(
      userId,
      Array.from({ length: 12 }, (_, i) => ({
        id: 800 + i,
        name: "Session",
        sport_type: i % 3 === 0 ? "Run" : i % 3 === 1 ? "Ride" : "Swim",
        start_date: daysAgo(i * 3 + 1),
        moving_time: 3600,
        distance: 10000,
        average_heartrate: 145,
        max_heartrate: 175,
      }))
    );
    await saveStravaToken(userId, {
      accessToken: "t",
      refreshToken: "r",
      expiresAt: new Date(Date.now() + 3600_000),
    });

    const realFetch = global.fetch;
    global.fetch = (async (url: any) => {
      if (String(url).endsWith("/athlete")) {
        return { ok: true, json: async () => ({ id: 1 }) } as any;
      }
      return { ok: true, status: 200, json: async () => [] } as any;
    }) as any;
    await prefillAthleteProfile(userId);
    global.fetch = realFetch;

    const profile = await prisma.athleteProfile.findUnique({ where: { userId } });
    check(
      "prefill never sets 'weekly hours available' from training volume",
      profile?.weeklyHoursAvailable === null,
      `got ${profile?.weeklyHoursAvailable}`
    );

    console.log("\nCapacity IS derived from what they actually did:");
    const capacity = await getCapacity(userId);
    check("capacity has data", capacity.hasData === true);
    check("recent weekly hours are calculated", capacity.recentWeeklyHours > 0);
    check("a peak week is identified", capacity.peakWeeklyHours > 0);
    check(
      "safe progression is capped at the ramp rate",
      capacity.safeNextWeekHours <=
        Math.max(capacity.recentWeeklyHours, capacity.peakWeeklyHours) * SAFE_RAMP_RATE + 0.1,
      `${capacity.safeNextWeekHours}`
    );
    check("the basis is explained", capacity.basis.includes("h/week"));

    console.log("\nCapacity known, time unknown — still don't assume:");
    budget = await getTrainingBudget(userId);
    check("no target is set without knowing their time", budget.recommendedWeeklyHours === null);
    check("the limit stays unknown", budget.bindingConstraint === "unknown");
    check(
      "the coach is warned not to assume time",
      budget.explanation.toLowerCase().includes("must not assume")
    );

    console.log("\nThe athlete enters their own availability:");
    await saveAvailability(userId, {
      monHours: 1,
      tueHours: 1.5,
      wedHours: 0,
      thuHours: 1,
      friHours: 0,
      satHours: 3,
      sunHours: 2,
      longSessionDay: "Saturday",
      constraints: "Pool closed Sundays",
      poolAccess: true,
      gymAccess: false,
      indoorTrainer: true,
    });

    const avail = await getAvailability(userId);
    check("availability is now set", avail.isSet === true);
    check("total hours are summed", avail.totalHours === 8.5, `got ${avail.totalHours}`);
    check("rest days are counted correctly", avail.trainingDays === 5, `got ${avail.trainingDays}`);
    check("the longest day is identified", avail.longestDayHours === 3);
    check("per-day detail is kept", avail.byDay[5].day === "Saturday" && avail.byDay[5].hours === 3);
    check("long session preference is stored", avail.longSessionDay === "Saturday");
    check("constraints are stored", avail.constraints === "Pool closed Sundays");
    check("facility access is stored", avail.gymAccess === false && avail.indoorTrainer === true);

    console.log("\nThe tighter limit wins:");
    budget = await getTrainingBudget(userId);
    // 8.5 h available, but only training ~4 h/week → the body is the limit.
    check(
      "when they have more time than fitness, CAPACITY limits the plan",
      budget.bindingConstraint === "capacity",
      budget.bindingConstraint
    );
    check(
      "the target is the smaller of the two",
      budget.recommendedWeeklyHours! < avail.totalHours,
      `${budget.recommendedWeeklyHours} vs ${avail.totalHours}`
    );
    check(
      "it explains not to fill the spare time immediately",
      budget.explanation.toLowerCase().includes("do not fill the spare time")
    );

    // Now squeeze their time right down.
    await saveAvailability(userId, {
      monHours: 0.5, tueHours: 0.5, wedHours: 0, thuHours: 0.5,
      friHours: 0, satHours: 1, sunHours: 0,
    });
    budget = await getTrainingBudget(userId);
    check(
      "when time is scarce, TIME limits the plan",
      budget.bindingConstraint === "time",
      budget.bindingConstraint
    );
    check(
      "the target equals their available time",
      budget.recommendedWeeklyHours === 2.5,
      `got ${budget.recommendedWeeklyHours}`
    );
    check(
      "it tells the coach to make sessions count",
      budget.explanation.toLowerCase().includes("make every session count")
    );

    console.log("\nInstructions reaching the AI coach:");
    await saveAvailability(userId, {
      monHours: 1, tueHours: 1.5, wedHours: 0, thuHours: 1,
      friHours: 0, satHours: 3, sunHours: 2,
      longSessionDay: "Saturday", constraints: "Pool closed Sundays",
      poolAccess: false, gymAccess: false, indoorTrainer: true,
    });
    budget = await getTrainingBudget(userId);
    const prompt = formatBudgetForPrompt(budget);

    check("the prompt lists per-day time", prompt.includes("Sat 3h"));
    check("it states the weekly total", prompt.includes("8.5 h/week"));
    check(
      "it forbids sessions longer than the day allows",
      prompt.includes("MUST fit inside that day")
    );
    check("it passes on the long session preference", prompt.includes("Saturday"));
    check("it passes on constraints", prompt.includes("Pool closed Sundays"));
    check("no pool means no pool sets", prompt.includes("NO pool access"));
    check("no gym means bodyweight strength", prompt.includes("bodyweight"));
    check("an indoor trainer is noted", prompt.includes("indoor trainer"));
    check("it includes current capacity", prompt.includes("Current physical capacity"));
    check("it caps weekly progression", prompt.includes("10% per week"));
    check("it gives a concrete target", prompt.includes("TARGET:"));

    console.log("\nSanity limits:");
    await saveAvailability(userId, { monHours: -5, tueHours: 99 });
    const clamped = await getAvailability(userId);
    check("negative hours become zero", clamped.byDay[0].hours === 0);
    check("absurd hours are capped at 24", clamped.byDay[1].hours === 24);
  } finally {
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => {});
    await prisma.$disconnect();
  }

  console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Test run crashed:", err);
  process.exit(1);
});

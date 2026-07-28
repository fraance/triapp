/**
 * Automated persistence tests for the TriApp foundation milestone.
 *
 * These run against the REAL database and verify that:
 *   1. Accounts are created and stored (with hashed passwords).
 *   2. Login only succeeds with the correct password.
 *   3. An athlete profile is saved and read back correctly.
 *   4. A generated training plan is saved and reconstructed correctly.
 *   5. Regenerating a plan replaces the previous one.
 *   6. Data survives being "reloaded" (a fresh read from the DB).
 *
 * No OpenAI / network calls are involved, so the test is fast and deterministic.
 * Run with:  npm test
 */
import "./env.mts";
import {
  createUser,
  getUserByEmail,
  verifyPassword,
  updateProfile,
  getProfile,
  saveFullPlan,
  getUserLatestPlanAsWeeks,
} from "../lib/db";
import { prisma } from "../lib/prisma";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean) {
  if (condition) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗ ${name}\x1b[0m`);
  }
}

async function main() {
  const email = `test_${Date.now()}@triapp.test`;
  const password = "s3cret-password";
  let userId = "";

  console.log("\nTriApp persistence tests\n");

  try {
    // 1. Account creation ----------------------------------------------------
    console.log("Accounts:");
    const user = await createUser(email, password);
    userId = user.id;
    check("signup creates a user with an id", !!user.id);
    check("signup stores the email", user.email === email);
    check(
      "password is hashed, not stored in plain text",
      user.password !== password && user.password.length > 20
    );

    const fetched = await getUserByEmail(email);
    check("user can be looked up by email", fetched?.id === userId);
    check(
      "a blank athlete profile is created on signup",
      fetched?.profile !== null && fetched?.profile !== undefined
    );

    // 2. Login / password verification --------------------------------------
    console.log("\nLogin:");
    check(
      "login succeeds with the correct password",
      await verifyPassword(password, fetched!.password)
    );
    check(
      "login fails with a wrong password",
      !(await verifyPassword("wrong-password", fetched!.password))
    );

    // 3. Profile persistence -------------------------------------------------
    console.log("\nProfile:");
    await updateProfile(userId, {
      age: 35,
      gender: "Female",
      raceType: "70.3",
      raceDate: new Date("2026-09-01"),
      pastPerformance: "Finished Olympic distance in 2:45.",
      timezone: "Europe/Paris",
    });
    const profile = await getProfile(userId);
    check("profile age is saved", profile?.age === 35);
    check("profile gender is saved", profile?.gender === "Female");
    check("profile race type is saved", profile?.raceType === "70.3");
    check(
      "profile free-text notes are saved",
      profile?.pastPerformance === "Finished Olympic distance in 2:45."
    );
    check("profile timezone is saved", profile?.timezone === "Europe/Paris");

    // 4. Plan persistence + reconstruction ----------------------------------
    console.log("\nTraining plan:");
    const samplePlan = [
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
            tss: 120,
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
        ],
      },
      {
        week: 2,
        phase: "Base Building",
        summary: "Slight volume increase",
        sessions: [
          {
            day: "Tuesday",
            discipline: "Bike",
            type: "Endurance",
            duration: "90 min",
            tss: 180,
            instructions: "Zone 2 steady",
            pace: "Zone 2",
          },
        ],
      },
    ];

    await saveFullPlan(userId, new Date("2026-09-01"), samplePlan);
    const weeks = await getUserLatestPlanAsWeeks(userId);
    check("a saved plan can be read back", !!weeks && weeks.length === 2);
    check("week 1 metadata (phase) is preserved", weeks?.[0].phase === "Base Building");
    check(
      "week 1 summary is preserved",
      weeks?.[0].summary === "Aerobic base week"
    );
    check(
      "week 1 has both of its sessions",
      weeks?.[0].sessions.length === 2
    );
    check(
      "session details (discipline) are preserved",
      weeks?.[0].sessions[0].discipline === "Swim"
    );
    check(
      "session TSS numbers are preserved",
      weeks?.[0].sessions[1].tss === 150
    );
    check("week 2 is preserved", weeks?.[1].sessions[0].discipline === "Bike");

    // 5. Regeneration replaces the old plan ---------------------------------
    console.log("\nRegeneration:");
    const newPlan = [
      {
        week: 1,
        phase: "Build",
        summary: "Higher intensity",
        sessions: [
          {
            day: "Friday",
            discipline: "Run",
            type: "Intervals",
            duration: "50 min",
            tss: 200,
            instructions: "6x800m",
            pace: "4:00/km",
          },
        ],
      },
    ];
    await saveFullPlan(userId, new Date("2026-09-01"), newPlan);
    const afterRegen = await getUserLatestPlanAsWeeks(userId);
    check(
      "regenerating replaces the old plan (only 1 week now)",
      afterRegen?.length === 1
    );
    check(
      "new plan content is returned",
      afterRegen?.[0].phase === "Build" &&
        afterRegen?.[0].sessions[0].discipline === "Run"
    );
    const planCount = await prisma.trainingPlan.count({ where: { userId } });
    check("no orphaned old plans remain in the database", planCount === 1);

    // 6. Data survives a completely fresh read ------------------------------
    console.log("\nDurability (simulating a new browser session):");
    const reloadedUser = await getUserByEmail(email);
    const reloadedProfile = await getProfile(reloadedUser!.id);
    const reloadedPlan = await getUserLatestPlanAsWeeks(reloadedUser!.id);
    check(
      "account, profile and plan are all still there after reload",
      !!reloadedUser && reloadedProfile?.age === 35 && reloadedPlan?.length === 1
    );
  } finally {
    // Cleanup: remove the test user (cascades to profile, plan, sessions)
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

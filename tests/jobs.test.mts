/**
 * Tests for settings persistence and the daily background sync job.
 *
 * Covers:
 *   1. Threshold/difficulty settings are stored in the database and survive a
 *      "fresh login" (a completely new read).
 *   2. A partial profile save does NOT wipe previously saved settings.
 *   3. Incremental sync only asks Strava for recent activities.
 *   4. The job records when it last ran, and records errors.
 *   5. The job iterates over every connected athlete.
 *
 * Run with:  npm run test:jobs
 */
import "./env.mts";
import {
  createUser,
  getUserByEmail,
  updateProfile,
  getProfile,
} from "../lib/db";
import {
  saveStravaToken,
  storeActivities,
  syncUserIncremental,
  syncAllConnectedUsers,
  getTssContext,
} from "../lib/strava-db";
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
  console.log("\nTriApp — settings persistence & background job tests\n");

  const emailA = `jobsA_${Date.now()}@triapp.test`;
  const emailB = `jobsB_${Date.now()}@triapp.test`;
  let userA = "";
  let userB = "";

  try {
    userA = (await createUser(emailA, "pw123456")).id;
    userB = (await createUser(emailB, "pw123456")).id;

    // ---- 1. Settings persist -------------------------------------------
    console.log("Settings are saved to the database:");
    await updateProfile(userA, {
      age: 35,
      gender: "Female",
      raceType: "70.3",
      maxHeartRate: 185,
      thresholdHeartRate: 168,
      ftpWatts: 240,
      runDifficulty: 1.3,
      swimDifficulty: 0.8,
      bikeDifficulty: 0.9,
    });

    const saved = await getProfile(userA);
    check("max HR is saved", saved?.maxHeartRate === 185);
    check("threshold HR is saved", saved?.thresholdHeartRate === 168);
    check("FTP is saved", saved?.ftpWatts === 240);
    check("run difficulty is saved", saved?.runDifficulty === 1.3);
    check("swim difficulty is saved", saved?.swimDifficulty === 0.8);
    check("bike difficulty is saved", saved?.bikeDifficulty === 0.9);

    console.log("\nSettings survive a fresh login (new read from the database):");
    const relogin = await getUserByEmail(emailA);
    check("profile is attached to the account", Boolean(relogin?.profile));
    check(
      "thresholds are still there after re-login",
      relogin?.profile?.thresholdHeartRate === 168 &&
        relogin?.profile?.maxHeartRate === 185
    );
    check(
      "difficulty settings are still there after re-login",
      relogin?.profile?.runDifficulty === 1.3
    );
    check(
      "the load calculator picks up the saved thresholds",
      (await getTssContext(userA)).thresholdHeartRate === 168
    );

    // ---- 2. Partial saves must not wipe settings ------------------------
    console.log("\nA partial save does not erase other settings:");
    // Simulate a screen that only updates the race date.
    await updateProfile(userA, { raceDate: new Date(2026, 9, 15) });
    const afterPartial = await getProfile(userA);
    check("race date was updated", afterPartial?.raceDate !== null);
    check(
      "threshold HR survived the partial save",
      afterPartial?.thresholdHeartRate === 168,
      `got ${afterPartial?.thresholdHeartRate}`
    );
    check(
      "run difficulty survived the partial save",
      afterPartial?.runDifficulty === 1.3,
      `got ${afterPartial?.runDifficulty}`
    );
    check("FTP survived the partial save", afterPartial?.ftpWatts === 240);

    // Explicitly clearing a field still works.
    await updateProfile(userA, { ftpWatts: null });
    check(
      "a field can still be deliberately cleared",
      (await getProfile(userA))?.ftpWatts === null
    );

    // ---- 3 & 4. Background sync ----------------------------------------
    console.log("\nDaily background sync:");

    await saveStravaToken(userA, {
      accessToken: "tokenA",
      refreshToken: "refreshA",
      expiresAt: new Date(Date.now() + 3600_000),
      athleteName: "Athlete A",
    });
    await saveStravaToken(userB, {
      accessToken: "tokenB",
      refreshToken: "refreshB",
      expiresAt: new Date(Date.now() + 3600_000),
      athleteName: "Athlete B",
    });

    // Give A some existing history so the sync goes incremental.
    const daysAgo = (n: number) =>
      new Date(Date.now() - n * 24 * 3600 * 1000).toISOString();
    await storeActivities(userA, [
      { id: 900, name: "Old run", sport_type: "Run", start_date: daysAgo(10), moving_time: 1800, distance: 5000 },
    ]);

    // Fake Strava returning one brand-new activity.
    const realFetch = global.fetch;
    const requestedUrls: string[] = [];
    global.fetch = (async (url: any) => {
      const u = String(url);
      requestedUrls.push(u);
      return {
        ok: true,
        json: async () => [
          {
            id: 901,
            name: "New ride",
            sport_type: "Ride",
            start_date: daysAgo(1),
            moving_time: 3600,
            distance: 30000,
          },
        ],
      } as any;
    }) as any;

    const resultA = await syncUserIncremental(userA);
    global.fetch = realFetch;

    check("sync reports success", resultA.ok === true, resultA.error);
    check("the new activity is imported", resultA.added === 1, `added ${resultA.added}`);
    check(
      "incremental sync asks Strava only for recent activities",
      requestedUrls.some((u) => u.includes("after=")),
      requestedUrls[0]
    );

    const activityCount = await prisma.stravaActivity.count({ where: { userId: userA } });
    check("both old and new activities are stored", activityCount === 2, `got ${activityCount}`);

    const tokenA = await prisma.stravaToken.findUnique({ where: { userId: userA } });
    check("the job records when it last ran", tokenA?.lastSyncedAt !== null);
    check("no error is recorded on success", tokenA?.lastSyncError === null);

    console.log("\nErrors are captured, not swallowed:");
    global.fetch = (async () => ({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    })) as any;
    const failedResult = await syncUserIncremental(userB);
    global.fetch = realFetch;

    check("a failing sync is reported as failed", failedResult.ok === false);
    check("the error message is returned", Boolean(failedResult.error));
    const tokenB = await prisma.stravaToken.findUnique({ where: { userId: userB } });
    check("the error is stored against the athlete", Boolean(tokenB?.lastSyncError));
    check("the attempt time is still recorded", tokenB?.lastSyncedAt !== null);

    console.log("\nThe job covers every connected athlete:");
    global.fetch = (async () => ({ ok: true, json: async () => [] })) as any;
    const summary = await syncAllConnectedUsers({ userIds: [userA, userB] });
    global.fetch = realFetch;

    check(
      "both connected athletes are processed",
      summary.users === 2,
      `got ${summary.users}`
    );
    check(
      "the job can be scoped so it never touches other athletes",
      summary.results.every((r) => [userA, userB].includes(r.userId))
    );
    check(
      "results are returned per athlete",
      summary.results.length === summary.users
    );
    check(
      "each result identifies the athlete",
      summary.results.every((r) => Boolean(r.userId))
    );
    check("all succeeded this time", summary.failed === 0, `failed ${summary.failed}`);
  } finally {
    for (const id of [userA, userB]) {
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

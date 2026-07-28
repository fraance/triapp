/**
 * Tests for automatic run personal bests pulled from Strava.
 *
 *   1. Standard distances are matched from Strava's best-effort names.
 *   2. PBs are detected from whole-run times when no official split exists.
 *   3. Runs that are the wrong distance are not counted.
 *   4. Strava's official splits take priority over whole-run times.
 *   5. PBs are written to the profile without ever overwriting a better time.
 *   6. Detailed-activity enrichment stores splits and handles rate limits.
 *
 * Run with:  npm run test:pbs
 */
import "./env.mts";
import { createUser, updateProfile } from "../lib/db";
import { storeActivities, saveStravaToken } from "../lib/strava-db";
import {
  detectPersonalBests,
  applyPersonalBestsToProfile,
  matchPbDistance,
  formatTime,
  enrichBestEfforts,
  PB_DISTANCES,
} from "../lib/personal-bests";
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
  console.log("\nTriApp — automatic personal bests from Strava\n");

  console.log("Distance matching:");
  check("matches 5k", matchPbDistance("5k")?.key === "pb5kSec");
  check("matches 10k", matchPbDistance("10k")?.key === "pb10kSec");
  check("matches half marathon", matchPbDistance("Half-Marathon")?.key === "pbHalfSec");
  check("matches marathon", matchPbDistance("Marathon")?.key === "pbMarathonSec");
  check("is case-insensitive", matchPbDistance("HALF-MARATHON")?.key === "pbHalfSec");
  check("ignores distances we don't track", matchPbDistance("400m") === null);
  check("ignores 1 mile", matchPbDistance("1 mile") === null);
  check("tracks four distances", PB_DISTANCES.length === 4);

  console.log("\nTime formatting:");
  check("formats under an hour", formatTime(1200) === "20:00", formatTime(1200));
  check("formats over an hour", formatTime(5460) === "1:31:00", formatTime(5460));

  const email = `pbs_${Date.now()}@triapp.test`;
  let userId = "";

  try {
    userId = (await createUser(email, "pw123456")).id;

    console.log("\nDetecting PBs from whole-run times:");
    await storeActivities(userId, [
      // Exactly 5 km in 21:00 — a valid 5k PB
      { id: 601, name: "Parkrun", sport_type: "Run", start_date: daysAgo(30), moving_time: 1260, distance: 5020 },
      // Faster 5 km, 20:00 — should become the PB
      { id: 602, name: "Fast parkrun", sport_type: "Run", start_date: daysAgo(10), moving_time: 1200, distance: 5010 },
      // 10 km in 43:20
      { id: 603, name: "10k race", sport_type: "Run", start_date: daysAgo(20), moving_time: 2600, distance: 10050 },
      // Half marathon in 1:35:00
      { id: 604, name: "Half marathon", sport_type: "Run", start_date: daysAgo(60), moving_time: 5700, distance: 21100 },
      // A 7 km run — not close to any standard distance
      { id: 605, name: "Easy run", sport_type: "Run", start_date: daysAgo(5), moving_time: 2400, distance: 7000 },
      // A ride the same length as a 10k — must be ignored
      { id: 606, name: "Ride", sport_type: "Ride", start_date: daysAgo(8), moving_time: 1200, distance: 10000 },
    ]);

    const pbs = await detectPersonalBests(userId);
    const byKey = new Map(pbs.map((p) => [p.key, p]));

    check("finds a 5k PB", byKey.has("pb5kSec"));
    check(
      "picks the FASTEST 5k, not the most recent",
      byKey.get("pb5kSec")?.seconds === 1200,
      `got ${byKey.get("pb5kSec")?.seconds}`
    );
    check("finds a 10k PB", byKey.get("pb10kSec")?.seconds === 2600);
    check("finds a half marathon PB", byKey.get("pbHalfSec")?.seconds === 5700);
    check("does not invent a marathon PB", !byKey.has("pbMarathonSec"));
    check(
      "a 7 km run is not counted as a 5k or 10k",
      byKey.get("pb5kSec")?.activityName !== "Easy run"
    );
    check(
      "cycling is never counted as a run PB",
      byKey.get("pb10kSec")?.activityName === "10k race"
    );
    check("records the date of the PB", Boolean(byKey.get("pb5kSec")?.date));
    check(
      "whole-run times are labelled as such",
      byKey.get("pb5kSec")?.precision === "activity"
    );

    console.log("\nOfficial Strava splits take priority:");
    // A 10 km run contains a faster 5 km split than any standalone 5k.
    const tenK = await prisma.stravaActivity.findFirst({
      where: { userId, stravaId: "603" },
    });
    await prisma.stravaBestEffort.create({
      data: {
        activityId: tenK!.id,
        userId,
        name: "5k",
        distance: 5000,
        elapsedTime: 1150, // 19:10 — faster than the standalone 5k
        startDate: tenK!.startDate,
      },
    });

    const pbs2 = await detectPersonalBests(userId);
    const best5k = pbs2.find((p) => p.key === "pb5kSec");
    check(
      "the official split beats the standalone run",
      best5k?.seconds === 1150,
      `got ${best5k?.seconds}`
    );
    check("it is labelled as an official split", best5k?.precision === "official");

    console.log("\nWriting PBs onto the profile:");
    const applied = await applyPersonalBestsToProfile(userId);
    check("reports what it updated", applied.updated.length > 0);

    const profile = await prisma.athleteProfile.findUnique({ where: { userId } });
    check("5k PB saved to profile", profile?.pb5kSec === 1150, `got ${profile?.pb5kSec}`);
    check("10k PB saved to profile", profile?.pb10kSec === 2600);
    check("half marathon PB saved", profile?.pbHalfSec === 5700);
    check("marathon left blank", profile?.pbMarathonSec === null);

    console.log("\nAthlete-entered times are never overwritten:");
    await updateProfile(userId, { pb5kSec: 1080 }); // athlete raced 18:00 elsewhere
    await applyPersonalBestsToProfile(userId);
    const after = await prisma.athleteProfile.findUnique({ where: { userId } });
    check(
      "a faster athlete-entered PB is preserved",
      after?.pb5kSec === 1080,
      `got ${after?.pb5kSec}`
    );

    // Per the project rule, a DIFFERENT stored time is not silently replaced —
    // the prefill engine raises it as a question for the athlete instead.
    await updateProfile(userId, { pb10kSec: 3000 }); // slower than detected 2600
    await applyPersonalBestsToProfile(userId);
    const after2 = await prisma.athleteProfile.findUnique({ where: { userId } });
    check(
      "a differing stored time is left alone, not silently replaced",
      after2?.pb10kSec === 3000,
      `got ${after2?.pb10kSec}`
    );

    console.log("\nFetching official splits from Strava:");
    await saveStravaToken(userId, {
      accessToken: "tok",
      refreshToken: "ref",
      expiresAt: new Date(Date.now() + 3600_000),
    });

    const realFetch = global.fetch;
    let detailCalls = 0;
    global.fetch = (async (url: any) => {
      detailCalls++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          best_efforts: [
            { name: "5k", distance: 5000, elapsed_time: 1190, moving_time: 1190, start_date: daysAgo(20) },
            { name: "400m", distance: 400, elapsed_time: 70 },
          ],
        }),
      } as any;
    }) as any;

    const enriched = await enrichBestEfforts(userId, { limit: 5 });
    global.fetch = realFetch;

    check("detailed activities are fetched", enriched.processed > 0, `processed ${enriched.processed}`);
    check("official splits are stored", enriched.effortsStored > 0);
    check("one API call per activity", detailCalls === enriched.processed);

    const stored = await prisma.stravaBestEffort.findMany({ where: { userId } });
    check(
      "untracked distances like 400m are ignored",
      stored.every((e) => e.name !== "400m")
    );

    // Running again should not refetch what we already have.
    global.fetch = (async () => {
      throw new Error("should not be called again");
    }) as any;
    const second = await enrichBestEfforts(userId, { limit: 5 });
    global.fetch = realFetch;
    check("already-detailed runs are not fetched twice", second.processed === 0);

    console.log("\nRate limiting is handled gracefully:");
    await prisma.stravaActivity.updateMany({
      where: { userId, discipline: "Run" },
      data: { detailsFetched: false },
    });
    global.fetch = (async () => ({
      ok: false,
      status: 429,
      text: async () => "Too Many Requests",
    })) as any;
    const limited = await enrichBestEfforts(userId, { limit: 5 });
    global.fetch = realFetch;
    check("stops cleanly when rate limited", limited.processed === 0);
    check("reports how many runs still need scanning", limited.remaining > 0);
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

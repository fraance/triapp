/**
 * Automated tests for the Strava integration.
 *
 * Covers the logic we own (no network calls to Strava are made):
 *   1. Sport-type mapping onto our four disciplines.
 *   2. Training-load (TSS) estimation.
 *   3. Activity normalisation from raw Strava payloads.
 *   4. Storing activities, including de-duplication on re-sync.
 *   5. Building the training-history summary the AI coach uses.
 *   6. Rendering that history into prompt text.
 *
 * Run with:  npm run test:strava
 */
import "./env.mts";
import {
  normaliseDiscipline,
  estimateTss,
  normaliseActivity,
  buildAuthorizeUrl,
  type RawStravaActivity,
} from "../lib/strava";
import {
  storeActivities,
  buildTrainingHistory,
  formatHistoryForPrompt,
  getActivityCount,
  saveStravaToken,
  getStravaToken,
  disconnectStrava,
} from "../lib/strava-db";
import { createUser } from "../lib/db";
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

/** Builds a fake Strava activity payload. */
function raw(over: Partial<RawStravaActivity> = {}): RawStravaActivity {
  return {
    id: Math.floor(Math.random() * 1e9),
    name: "Test activity",
    sport_type: "Run",
    start_date: new Date().toISOString(),
    moving_time: 3600,
    distance: 10000,
    ...over,
  };
}

async function main() {
  console.log("\nTriApp — Strava integration tests\n");

  console.log("Sport type mapping:");
  check("Run maps to Run", normaliseDiscipline("Run") === "Run");
  check("TrailRun maps to Run", normaliseDiscipline("TrailRun") === "Run");
  check("Ride maps to Bike", normaliseDiscipline("Ride") === "Bike");
  check("VirtualRide maps to Bike", normaliseDiscipline("VirtualRide") === "Bike");
  check("Swim maps to Swim", normaliseDiscipline("Swim") === "Swim");
  check(
    "WeightTraining maps to Strength",
    normaliseDiscipline("WeightTraining") === "Strength"
  );
  check("Kayaking falls back to Other", normaliseDiscipline("Kayaking") === "Other");
  check("Hike is NOT counted as a run", normaliseDiscipline("Hike") === "Other");
  check("Walk is NOT counted as a run", normaliseDiscipline("Walk") === "Other");
  check("TrailRun is still a run", normaliseDiscipline("TrailRun") === "Run");
  check("unknown/empty is handled", normaliseDiscipline("") === "Other");

  console.log("\nTraining load estimation:");
  check(
    "uses Strava suffer score when available",
    estimateTss({ movingTime: 3600, discipline: "Run", sufferScore: 88 }) === 88
  );
  const oneHourRun = estimateTss({ movingTime: 3600, discipline: "Run" });
  check("a 1h run produces a sensible load", oneHourRun > 40 && oneHourRun < 90, `got ${oneHourRun}`);
  const twoHourRide = estimateTss({ movingTime: 7200, discipline: "Bike" });
  const oneHourRide = estimateTss({ movingTime: 3600, discipline: "Bike" });
  check(
    "a 2h ride is roughly double a 1h ride",
    Math.abs(twoHourRide - 2 * oneHourRide) <= 1,
    `1h=${oneHourRide} 2h=${twoHourRide}`
  );
  const easy = estimateTss({
    movingTime: 3600,
    discipline: "Run",
    avgHeartRate: 120,
    maxHeartRate: 190,
  });
  const hard = estimateTss({
    movingTime: 3600,
    discipline: "Run",
    avgHeartRate: 175,
    maxHeartRate: 190,
  });
  check("higher heart rate produces a higher load", hard > easy, `easy=${easy} hard=${hard}`);
  check("zero duration produces zero load", estimateTss({ movingTime: 0, discipline: "Run" }) === 0);

  console.log("\nActivity normalisation:");
  const norm = normaliseActivity(
    raw({
      id: 12345,
      name: "Morning Ride",
      sport_type: "Ride",
      moving_time: 5400,
      distance: 45000,
      average_heartrate: 145,
      total_elevation_gain: 320,
    })
  );
  check("keeps Strava's id as a string", norm.stravaId === "12345");
  check("maps the discipline", norm.discipline === "Bike");
  check("keeps the name", norm.name === "Morning Ride");
  check("keeps distance in meters", norm.distance === 45000);
  check("captures elevation", norm.elevationGain === 320);
  check("computes an estimated load", norm.estimatedTss > 0);

  console.log("\nOAuth URL:");
  const url = buildAuthorizeUrl("user-123");
  check("authorize URL points at Strava", url.startsWith("https://www.strava.com/oauth/authorize"));
  check("carries the userId as state", url.includes("state=user-123"));
  check("requests activity read scope", url.includes("activity%3Aread_all"));

  // ---- Database-backed ---------------------------------------------------
  const email = `strava_${Date.now()}@triapp.test`;
  let userId = "";

  try {
    const user = await createUser(email, "pw123456");
    userId = user.id;

    console.log("\nToken storage:");
    await saveStravaToken(userId, {
      accessToken: "access-abc",
      refreshToken: "refresh-xyz",
      expiresAt: new Date(Date.now() + 3600 * 1000),
      athleteId: "999",
      athleteName: "France Hemain",
    });
    const tok = await getStravaToken(userId);
    check("token is stored against the user", tok?.accessToken === "access-abc");
    check("refresh token is stored", tok?.refreshToken === "refresh-xyz");
    check("athlete name is stored", tok?.athleteName === "France Hemain");

    console.log("\nActivity import & de-duplication:");
    const daysAgo = (n: number) =>
      new Date(Date.now() - n * 24 * 3600 * 1000).toISOString();

    const batch: RawStravaActivity[] = [
      raw({ id: 1, sport_type: "Swim", name: "Pool", moving_time: 2400, distance: 2000, start_date: daysAgo(2) }),
      raw({ id: 2, sport_type: "Ride", name: "Long ride", moving_time: 7200, distance: 60000, start_date: daysAgo(4), average_heartrate: 140 }),
      raw({ id: 3, sport_type: "Run", name: "Tempo", moving_time: 2700, distance: 9000, start_date: daysAgo(6), average_heartrate: 165 }),
      raw({ id: 4, sport_type: "Run", name: "Long run", moving_time: 5400, distance: 18000, start_date: daysAgo(9) }),
    ];

    const first = await storeActivities(userId, batch);
    check("all new activities are added", first.added === 4, `added ${first.added}`);
    check("nothing was skipped on first import", first.skipped === 0);
    check("activity count matches", (await getActivityCount(userId)) === 4);

    // Re-sync the same data plus one new activity
    const second = await storeActivities(userId, [
      ...batch,
      raw({ id: 5, sport_type: "Swim", name: "Open water", moving_time: 1800, distance: 1500, start_date: daysAgo(1) }),
    ]);
    check("re-syncing does not duplicate existing activities", second.added === 1, `added ${second.added}`);
    check("existing activities are reported as skipped", second.skipped === 4);
    check("total count is correct after re-sync", (await getActivityCount(userId)) === 5);

    console.log("\nTraining history summary (AI context):");
    const history = await buildTrainingHistory(userId, 90);
    check("history reports it has data", history.hasData === true);
    check("counts all activities", history.totalActivities === 5, `got ${history.totalActivities}`);
    check("computes average weekly hours", history.avgWeeklyHours > 0);
    check("computes average weekly load", history.avgWeeklyTss > 0);
    check(
      "breaks down by discipline",
      history.byDiscipline.length === 3,
      `got ${history.byDiscipline.map((d) => d.discipline).join(",")}`
    );
    const swim = history.byDiscipline.find((d) => d.discipline === "Swim");
    check("swim sessions are counted", swim?.count === 2, `got ${swim?.count}`);
    const bike = history.byDiscipline.find((d) => d.discipline === "Bike");
    check("bike distance is aggregated (60 km)", bike?.totalDistanceKm === 60);
    check("longest ride is captured", history.longestRideKm === 60, `got ${history.longestRideKm}`);
    check("longest run is captured", history.longestRunKm === 18, `got ${history.longestRunKm}`);
    check("recent activities are listed", history.recentActivities.length === 5);
    check(
      "recent activities are newest first",
      history.recentActivities[0].name === "Open water",
      history.recentActivities[0].name
    );

    console.log("\nPrompt text for the AI coach:");
    const promptText = formatHistoryForPrompt(history);
    check("mentions real training history", promptText.includes("REAL TRAINING HISTORY"));
    check("includes weekly hours", promptText.includes("h/week"));
    check("includes each discipline", promptText.includes("Swim:") && promptText.includes("Bike:"));
    check("includes longest ride", promptText.includes("Longest ride"));
    check(
      "instructs the coach not to over-prescribe",
      promptText.toLowerCase().includes("do not prescribe large jumps")
    );
    check("empty history produces no prompt text", formatHistoryForPrompt({
      hasData: false, totalActivities: 0, weeksAnalysed: 0, avgWeeklyHours: 0,
      avgWeeklyTss: 0, byDiscipline: [], longestRideKm: 0, longestRunKm: 0,
      longestSwimKm: 0, recentActivities: [],
    }) === "");

    console.log("\nDisconnect:");
    await disconnectStrava(userId);
    check("token is removed on disconnect", (await getStravaToken(userId)) === null);
    check(
      "activities are kept after disconnect",
      (await getActivityCount(userId)) === 5
    );
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

/**
 * Tests for automated athlete profiling.
 *
 *   1. Metrics derived automatically from real activity data (FTP, CSS,
 *      threshold pace, HR anchors, volume) — behaviour 1.
 *   2. Manually entered values always beat estimates.
 *   3. Equipment audit deduced from data streams — behaviour 3.
 *   4. Gap analysis + baseline test injection, gated on equipment — behaviour 4.
 *   5. Race profiling returns suggestions that must be confirmed, and never
 *      invents data — behaviour 2.
 *   6. The whole picture is rendered into the AI coaching prompt.
 *
 * Run with:  npm run test:athlete
 */
import "./env.mts";
import { createUser, updateProfile } from "../lib/db";
import { storeActivities } from "../lib/strava-db";
import {
  deriveAthleteMetrics,
  auditEquipment,
  formatPace,
} from "../lib/athlete-metrics";
import {
  analyseGaps,
  formatTestsForPrompt,
  TEST_PROTOCOLS,
} from "../lib/baseline-tests";
import {
  parseResearchResponse,
  formatRaceProfileForPrompt,
  FALLBACK_QUESTIONS,
  enforceIdentification,
} from "../lib/race-profile";
import { buildAthleteContext } from "../lib/athlete-context";
import { saveAvailability } from "../lib/availability";
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
  console.log("\nTriApp — automated athlete profiling tests\n");

  // ---- Equipment audit (pure) --------------------------------------------
  console.log("Equipment audit from data streams:");
  const richStream = [
    { discipline: "Bike", avgWatts: 210, avgHeartRate: 145, distance: 40000, isTrainer: false },
    { discipline: "Bike", avgWatts: 220, avgHeartRate: 150, distance: 50000, isTrainer: true },
    { discipline: "Bike", avgWatts: 200, avgHeartRate: 140, distance: 30000, isTrainer: true },
    { discipline: "Run", avgHeartRate: 160, distance: 10000, isTrainer: false },
    { discipline: "Swim", distance: 2000, isTrainer: false },
    { discipline: "Swim", distance: 1500, isTrainer: false },
  ];
  const eq = auditEquipment(richStream);
  check("power meter detected from watts", eq.powerMeter === true);
  check("HR monitor detected", eq.heartRateMonitor === true);
  check("indoor trainer detected", eq.smartTrainer === true);
  check("GPS device detected", eq.gpsWatch === true);
  check("swim tracking detected", eq.swimTracking === true);
  check("evidence is explained in plain English", eq.evidence.length >= 4);

  const bareStream = [
    { discipline: "Run", distance: 5000, isTrainer: false },
    { discipline: "Run", distance: 8000, isTrainer: false },
    { discipline: "Run", distance: 6000, isTrainer: false },
  ];
  const bare = auditEquipment(bareStream);
  check("no power meter claimed when no watts present", bare.powerMeter === false);
  check("no HR monitor claimed when no HR present", bare.heartRateMonitor === false);
  check("no swim tracking claimed when no swims", bare.swimTracking === false);
  check("cadence sensor is never falsely claimed", bare.cadenceSensor === false);

  console.log("\nPace formatting:");
  check("formats seconds as m:ss", formatPace(272) === "4:32", formatPace(272));
  check("pads seconds", formatPace(245) === "4:05", formatPace(245));

  // ---- Race research parsing (pure) --------------------------------------
  console.log("\nRace profiling stays honest:");
  const confident = parseResearchResponse(
    JSON.stringify({
      raceName: "Ironman 70.3 Nice",
      location: "Nice, France",
      swimEnvironment: "ocean",
      waterTempC: 22,
      wetsuitLikely: true,
      bikeElevationGainM: 1200,
      bikeCourseType: "mountainous",
      runElevationGainM: 100,
      runCourseType: "flat",
      runSurface: "road",
      expectedTempC: 27,
      expectedHumidity: 60,
      aiConfidence: "high",
      unknownFields: [],
      questionsForAthlete: [],
    })
  );
  check("parses a confident result", confident.bikeElevationGainM === 1200);
  check("keeps swim environment", confident.swimEnvironment === "ocean");
  check("records confidence", confident.aiConfidence === "high");

  const vague = parseResearchResponse(
    JSON.stringify({
      raceName: "Some Local Tri",
      swimEnvironment: null,
      bikeElevationGainM: null,
      runElevationGainM: null,
      expectedTempC: null,
      aiConfidence: "low",
      unknownFields: [],
      questionsForAthlete: [],
    })
  );
  check(
    "unknown values are never invented",
    vague.bikeElevationGainM === null && vague.swimEnvironment === null
  );
  check(
    "missing fields are listed as unknown",
    vague.unknownFields.length === 4,
    vague.unknownFields.join(", ")
  );
  check(
    "the athlete is asked when the AI doesn't know",
    vague.questionsForAthlete.length > 0
  );
  check(
    "unknown strings like 'N/A' are treated as missing",
    parseResearchResponse(JSON.stringify({ swimEnvironment: "unknown", aiConfidence: "low" }))
      .swimEnvironment === null
  );
  check("fallback questions exist", FALLBACK_QUESTIONS.length >= 4);

  console.log("\nUnidentified races never produce invented data:");
  const fabricated = {
    ...vague,
    raceIdentified: false,
    swimEnvironment: "lake",
    waterTempC: 15,
    bikeElevationGainM: 800,
    runElevationGainM: 140,
    expectedTempC: 24,
    aiConfidence: "medium" as const,
  };
  const guarded = enforceIdentification(fabricated as any, "Some Unknown Race");
  check("invented bike elevation is discarded", guarded.bikeElevationGainM === null);
  check("invented run elevation is discarded", guarded.runElevationGainM === null);
  check("invented water temperature is discarded", guarded.waterTempC === null);
  check("invented swim environment is discarded", guarded.swimEnvironment === null);
  check("invented weather is discarded", guarded.expectedTempC === null);
  check("confidence is forced to low", guarded.aiConfidence === "low");
  check("the athlete is asked instead", guarded.questionsForAthlete.length > 0);
  check("all course fields are listed as unknown", guarded.unknownFields.length >= 6);
  check("a race name is still kept so the athlete isn't confused", guarded.raceName !== null);
  check(
    "the athlete's typed name is used when nothing was found",
    enforceIdentification(
      { ...fabricated, raceName: null } as any,
      "Some Unknown Race"
    ).raceName === "Some Unknown Race"
  );

  const identified = enforceIdentification(
    { ...fabricated, raceIdentified: true } as any,
    "Real Race"
  );
  check(
    "a positively identified race keeps its researched values",
    identified.bikeElevationGainM === 800 && identified.swimEnvironment === "lake"
  );

  const raceText = formatRaceProfileForPrompt({
    raceName: "IM 70.3 Nice",
    swimEnvironment: "ocean",
    waterTempC: 22,
    wetsuitLikely: true,
    bikeElevationGainM: 1200,
    bikeCourseType: "mountainous",
    runCourseType: "flat",
    expectedTempC: 30,
  });
  check("race demands become prompt text", raceText.includes("GOAL RACE DEMANDS"));
  check("mentions open water", raceText.includes("ocean"));
  check("mentions climbing", raceText.includes("1200 m elevation"));
  check(
    "instructs the coach to adapt to conditions",
    raceText.toLowerCase().includes("heat acclimatisation")
  );

  // ---- Database-backed ----------------------------------------------------
  const email = `athlete_${Date.now()}@triapp.test`;
  let userId = "";

  try {
    userId = (await createUser(email, "pw123456")).id;

    console.log("\nMetrics derived automatically from activity data:");
    await storeActivities(userId, [
      // Rides with power → FTP estimate
      { id: 1, name: "Threshold ride", sport_type: "Ride", start_date: daysAgo(5), moving_time: 3600, distance: 35000, average_watts: 240, average_heartrate: 155, max_heartrate: 178 },
      { id: 2, name: "Endurance ride", sport_type: "Ride", start_date: daysAgo(9), moving_time: 5400, distance: 55000, average_watts: 190, average_heartrate: 140, max_heartrate: 170 },
      { id: 3, name: "Trainer", sport_type: "VirtualRide", start_date: daysAgo(12), moving_time: 2700, distance: 25000, average_watts: 210, trainer: true, max_heartrate: 172 },
      // Runs → threshold pace (fastest = 4:00/km => avg speed 4.1667 m/s)
      { id: 4, name: "Tempo run", sport_type: "Run", start_date: daysAgo(3), moving_time: 1800, distance: 7500, average_speed: 4.1667, average_heartrate: 168, max_heartrate: 186 },
      { id: 5, name: "Long run", sport_type: "Run", start_date: daysAgo(7), moving_time: 3600, distance: 12000, average_speed: 3.333, average_heartrate: 150, max_heartrate: 175 },
      // Swims → CSS (fastest 100m pace: 2000m in 2800s => 140s/100m)
      { id: 6, name: "Swim session", sport_type: "Swim", start_date: daysAgo(4), moving_time: 2800, distance: 2000 },
      { id: 7, name: "Easy swim", sport_type: "Swim", start_date: daysAgo(10), moving_time: 1800, distance: 1000 },
    ]);

    const m = await deriveAthleteMetrics(userId);
    check("reports it has activity data", m.hasActivityData === true);
    check("counts the activities", m.activityCount === 7);

    check(
      "max HR derived from the athlete's own data",
      m.maxHeartRate.value === 186,
      `got ${m.maxHeartRate.value}`
    );
    check("max HR is flagged as derived, not measured", m.maxHeartRate.source === "derived");
    check("max HR explains where it came from", Boolean(m.maxHeartRate.basis));

    check(
      "FTP estimated from best sustained power (240 x 0.95)",
      m.ftpWatts.value === 228,
      `got ${m.ftpWatts.value}`
    );
    check("FTP is flagged as an estimate", m.ftpWatts.source === "derived");

    check(
      "run threshold pace estimated from fastest sustained run",
      m.runThresholdPaceSec.value === 240,
      `got ${m.runThresholdPaceSec.value}`
    );
    check(
      "swim CSS estimated from fastest swim pace",
      m.swimCssSecPer100.value === 140,
      `got ${m.swimCssSecPer100.value}`
    );
    check("weekly volume is calculated", (m.weeklyHours.value ?? 0) > 0);
    check("bike threshold HR is estimated", (m.bikeLthr.value ?? 0) > 0);
    check("run threshold HR is estimated", (m.runLthr.value ?? 0) > 0);
    check("equipment audit runs on real data", m.equipment.powerMeter === true);

    console.log("\nAthlete-entered values beat estimates:");
    await updateProfile(userId, { ftpWatts: 265, maxHeartRate: 191, weightKg: 68 });
    const m2 = await deriveAthleteMetrics(userId);
    check("manual FTP wins", m2.ftpWatts.value === 265);
    check("manual FTP is marked as confirmed", m2.ftpWatts.source === "measured");
    check("manual max HR wins", m2.maxHeartRate.value === 191);
    check(
      "power-to-weight computed from FTP and weight",
      m2.ftpPerKg.value === Math.round((265 / 68) * 100) / 100,
      `got ${m2.ftpPerKg.value}`
    );

    console.log("\nGap analysis and baseline tests:");
    const gapsWithGear = analyseGaps(m2, { weightKg: 68 });
    const testKeys = gapsWithGear.recommendedTests.map((t) => t.key);
    check(
      "an FTP test is NOT suggested when FTP is already confirmed",
      !testKeys.includes("ftp20")
    );
    check("a swim CSS test is suggested", testKeys.includes("cssSwim"), testKeys.join(","));
    check(
      "gaps the athlete must answer are separated out",
      gapsWithGear.askTheAthlete.some((g) => g.field === "injuryHistory")
    );
    check(
      "weekly availability is flagged as critical",
      gapsWithGear.gaps.some(
        (g) => g.field === "weeklyHoursAvailable" && g.severity === "critical"
      )
    );
    check("a readiness score is produced", gapsWithGear.readiness > 0);

    // An athlete with no power meter must NOT be told to do an FTP test.
    const noGearMetrics = {
      ...m2,
      ftpWatts: { value: null, source: "missing" as const, confidence: null },
      equipment: { ...m2.equipment, powerMeter: false, smartTrainer: false },
    };
    const noGear = analyseGaps(noGearMetrics as any, {});
    check(
      "no FTP test when the athlete has no power meter",
      !noGear.recommendedTests.some((t) => t.key === "ftp20")
    );
    check(
      "instead it notes bike work will be paced by HR/feel",
      noGear.gaps.some(
        (g) => g.field === "ftpWatts" && g.resolution === "ask"
      )
    );

    const noHrMetrics = {
      ...m2,
      maxHeartRate: { value: null, source: "missing" as const, confidence: null },
      equipment: { ...m2.equipment, heartRateMonitor: false },
    };
    check(
      "no max-HR test when there is no heart-rate monitor",
      !analyseGaps(noHrMetrics as any, {}).recommendedTests.some((t) => t.key === "maxHr")
    );

    console.log("\nTest protocols:");
    check("FTP protocol explains the 95% rule", TEST_PROTOCOLS.ftp20.instructions.includes("95%"));
    check("CSS protocol uses 400m + 200m", TEST_PROTOCOLS.cssSwim.instructions.includes("400m"));
    check("5k protocol exists", TEST_PROTOCOLS.run5k.discipline === "Run");
    const testPrompt = formatTestsForPrompt(gapsWithGear.recommendedTests);
    check("tests become prompt instructions", testPrompt.includes("BASELINE TESTING REQUIRED"));
    check("tests are scheduled early", testPrompt.includes("first 1-2 weeks"));
    check("no two tests on consecutive days", testPrompt.includes("consecutive days"));
    check("empty test list produces no text", formatTestsForPrompt([]) === "");

    console.log("\nComplete athlete context for the AI coach:");
    await saveAvailability(userId, {
      monHours: 1, tueHours: 1, wedHours: 1, thuHours: 1,
      friHours: 0, satHours: 3, sunHours: 1,
    });
    await updateProfile(userId, {
      heightCm: 178,
      favouriteSport: "Bike",
      leastFavouriteSport: "Swim",
      injuryHistory: "Left achilles tendinopathy in 2024",
      tracksMenstrualCycle: true,
      cycleLengthDays: 28,
      pb5kSec: 1200,
    });
    await prisma.raceProfile.create({
      data: {
        userId,
        raceName: "IM 70.3 Nice",
        swimEnvironment: "ocean",
        bikeElevationGainM: 1200,
        bikeCourseType: "mountainous",
        expectedTempC: 30,
        confirmed: true,
        source: "manual",
      },
    });

    const context = await buildAthleteContext(userId);
    check("includes the athlete profile", context.includes("ATHLETE PROFILE"));
    check(
      "includes the athlete's own time budget",
      context.includes("8 h/week") && context.includes("TIME AVAILABLE"),
      "budget section missing"
    );
    check(
      "separates time available from physical capacity",
      context.includes("Current physical capacity")
    );
    check("includes the injury history", context.includes("achilles"));
    check("includes health section", context.includes("HEALTH & INJURY"));
    check("respects the menstrual cycle", context.toLowerCase().includes("follicular"));
    check("flags least favourite discipline", context.includes("Least favourite"));
    check("includes performance markers", context.includes("CURRENT PERFORMANCE MARKERS"));
    check("distinguishes confirmed vs estimated", context.includes("confirmed") && context.includes("estimated"));
    check("includes run personal best", context.includes("5k 20:00"));
    check("includes equipment section", context.includes("EQUIPMENT AVAILABLE"));
    check("includes race demands", context.includes("GOAL RACE DEMANDS"));
    check("includes mountainous bike course", context.includes("mountainous"));
    check("includes baseline testing block", context.includes("BASELINE TESTING"));

    // An athlete with no power meter must be told to avoid watts.
    await prisma.stravaActivity.deleteMany({ where: { userId } });
    await storeActivities(userId, [
      { id: 50, name: "Run", sport_type: "Run", start_date: daysAgo(2), moving_time: 1800, distance: 5000 },
      { id: 51, name: "Run", sport_type: "Run", start_date: daysAgo(4), moving_time: 2400, distance: 7000 },
      { id: 52, name: "Run", sport_type: "Run", start_date: daysAgo(6), moving_time: 1800, distance: 5000 },
    ]);
    const noGearContext = await buildAthleteContext(userId);
    check(
      "tells the coach not to prescribe watts without a power meter",
      noGearContext.includes("NOT watts")
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

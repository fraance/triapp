/**
 * Tests for the prefill rule:
 * "Never ask the athlete for something we can already work out."
 *
 *   1. Blank fields are filled from Strava's athlete profile (weight, FTP, sex).
 *   2. Blank fields are filled from derived activity metrics.
 *   3. Personal bests are filled in automatically.
 *   4. Values the athlete entered are NEVER overwritten.
 *   5. A worse stored value (slower PB) IS improved.
 *   6. Every filled value reports where it came from.
 *   7. Missing sources degrade gracefully instead of failing.
 *
 * Run with:  npm run test:prefill
 */
import "./env.mts";
import { createUser, updateProfile } from "../lib/db";
import { storeActivities, saveStravaToken } from "../lib/strava-db";
import {
  prefillAthleteProfile,
  isMeaningfulDifference,
  getPendingSuggestions,
  resolveSuggestion,
} from "../lib/prefill";
import { mapStravaSex } from "../lib/strava";
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

/** Fakes Strava's /athlete endpoint plus anything else that gets called. */
function mockStrava(athlete: any) {
  const real = global.fetch;
  global.fetch = (async (url: any) => {
    const u = String(url);
    if (u.includes("/athlete/activities")) {
      return { ok: true, json: async () => [] } as any;
    }
    if (u.endsWith("/athlete")) {
      return { ok: true, json: async () => athlete } as any;
    }
    if (u.includes("/activities/")) {
      return { ok: true, status: 200, json: async () => ({ best_efforts: [] }) } as any;
    }
    return { ok: true, json: async () => ({}) } as any;
  }) as any;
  return () => {
    global.fetch = real;
  };
}

async function main() {
  console.log("\nTriApp — prefill rule tests\n");

  console.log("Difference tolerances:");
  check(
    "a 0.2 kg weight difference is trivial",
    !isMeaningfulDifference("weightKg", 62.5, 62.7)
  );
  check(
    "a 7 kg weight difference matters",
    isMeaningfulDifference("weightKg", 62.5, 70)
  );
  check("a 2 bpm HR difference is trivial", !isMeaningfulDifference("maxHeartRate", 190, 192));
  check("a 10 bpm HR difference matters", isMeaningfulDifference("maxHeartRate", 190, 200));
  check("a 3 W FTP difference is trivial", !isMeaningfulDifference("ftpWatts", 250, 253));
  check("a 35 W FTP difference matters", isMeaningfulDifference("ftpWatts", 215, 250));
  check("different text values matter", isMeaningfulDifference("gender", "Male", "Female"));
  check("identical text does not", !isMeaningfulDifference("gender", "Female", "female"));
  check("a blank value is never a conflict", !isMeaningfulDifference("weightKg", null, 62));

  console.log("\nStrava sex mapping:");
  check("F maps to Female", mapStravaSex("F") === "Female");
  check("M maps to Male", mapStravaSex("M") === "Male");
  check("missing sex stays null", mapStravaSex(null) === null);

  const email = `prefill_${Date.now()}@triapp.test`;
  let userId = "";

  try {
    userId = (await createUser(email, "pw123456")).id;
    await saveStravaToken(userId, {
      accessToken: "tok",
      refreshToken: "ref",
      expiresAt: new Date(Date.now() + 3600_000),
    });

    // Real training history to derive metrics and PBs from.
    await storeActivities(userId, [
      { id: 701, name: "Threshold ride", sport_type: "Ride", start_date: daysAgo(4), moving_time: 3600, distance: 34000, average_watts: 230, average_heartrate: 152, max_heartrate: 179 },
      { id: 702, name: "Long ride", sport_type: "Ride", start_date: daysAgo(11), moving_time: 5400, distance: 52000, average_watts: 185, max_heartrate: 174 },
      { id: 703, name: "Parkrun", sport_type: "Run", start_date: daysAgo(6), moving_time: 1260, distance: 5030, average_speed: 3.99, average_heartrate: 170, max_heartrate: 188 },
      { id: 704, name: "10k", sport_type: "Run", start_date: daysAgo(13), moving_time: 2700, distance: 10040, average_speed: 3.72, max_heartrate: 182 },
      { id: 705, name: "Swim", sport_type: "Swim", start_date: daysAgo(8), moving_time: 2700, distance: 2000 },
    ]);

    console.log("\nPrefilling a blank profile:");
    let restore = mockStrava({
      id: 1,
      sex: "F",
      weight: 62.5,
      ftp: 215,
      city: "Evian-les-Bains",
      country: "France",
    });
    const first = await prefillAthleteProfile(userId);
    restore();

    const byField = new Map(first.applied.map((a) => [a.field, a]));

    check("weight comes from the Strava profile", byField.get("weightKg")?.value === 62.5);
    check(
      "weight says where it came from",
      byField.get("weightKg")?.origin.includes("Strava profile"),
      byField.get("weightKg")?.origin
    );
    check("FTP comes from the Strava profile", byField.get("ftpWatts")?.value === 215);
    check("sex is filled from Strava", byField.get("gender")?.value === "Female");
    check("max heart rate is derived from activities", byField.has("maxHeartRate"));
    check(
      "max HR explains its basis",
      Boolean(byField.get("maxHeartRate")?.origin),
      byField.get("maxHeartRate")?.origin
    );
    check("run threshold pace is derived", byField.has("runThresholdPaceSec"));
    check("swim CSS is derived", byField.has("swimCssSecPer100"));
    // Availability is a life constraint, not something we can infer from how
    // much someone happens to have trained. It must never be auto-filled.
    check(
      "available time is NEVER inferred from training volume",
      !byField.has("weeklyHoursAvailable")
    );
    check("5k personal best is filled in", byField.has("pb5kSec"));
    check("10k personal best is filled in", byField.has("pb10kSec"));
    check(
      "every filled value carries a human-readable origin",
      first.applied.every((a) => Boolean(a.origin) && Boolean(a.display))
    );

    const saved = await prisma.athleteProfile.findUnique({ where: { userId } });
    check("values are actually persisted", saved?.weightKg === 62.5 && saved?.ftpWatts === 215);
    check("sex persisted", saved?.gender === "Female");
    check("5k PB persisted", saved?.pb5kSec === 1260, `got ${saved?.pb5kSec}`);

    console.log("\nDifferences are raised as questions, never silently applied:");
    await updateProfile(userId, {
      weightKg: 70, // Strava says 62.5 — a real difference
      ftpWatts: 250, // Strava says 215
      maxHeartRate: 195, // data says 188
    });

    restore = mockStrava({ id: 1, sex: "F", weight: 62.5, ftp: 215, city: "Evian-les-Bains" });
    const second = await prefillAthleteProfile(userId);
    restore();

    const conflictFields = new Set(second.conflicts.map((c) => c.field));
    check("a differing weight is raised as a conflict", conflictFields.has("weightKg"));
    check("a differing FTP is raised as a conflict", conflictFields.has("ftpWatts"));
    check("a differing max HR is raised as a conflict", conflictFields.has("maxHeartRate"));

    const weightConflict = second.conflicts.find((c) => c.field === "weightKg");
    check("the conflict shows the athlete's value", weightConflict?.currentDisplay === "70");
    check("the conflict shows our value", weightConflict?.suggestedDisplay === "62.5 kg");
    check("the conflict explains where ours came from", Boolean(weightConflict?.origin));

    const stillMine = await prisma.athleteProfile.findUnique({ where: { userId } });
    check("nothing is changed while the question is open", stillMine?.weightKg === 70);
    check("FTP is untouched too", stillMine?.ftpWatts === 250);

    console.log("\nThe athlete decides:");
    const pending = await getPendingSuggestions(userId);
    check("questions are stored for later", pending.length >= 3, `got ${pending.length}`);

    await resolveSuggestion(userId, "weightKg", "accept");
    const accepted = await prisma.athleteProfile.findUnique({ where: { userId } });
    check(
      "accepting applies our value",
      accepted?.weightKg === 62.5,
      `got ${accepted?.weightKg}`
    );

    await resolveSuggestion(userId, "ftpWatts", "dismiss");
    const dismissed = await prisma.athleteProfile.findUnique({ where: { userId } });
    check("dismissing keeps the athlete's value", dismissed?.ftpWatts === 250);

    console.log("\nAnswered questions are not asked again:");
    restore = mockStrava({ id: 1, sex: "F", weight: 62.5, ftp: 215, city: "Evian-les-Bains" });
    const third = await prefillAthleteProfile(userId);
    restore();
    check(
      "a dismissed suggestion does not come back",
      !third.conflicts.some((c) => c.field === "ftpWatts")
    );
    check(
      "an accepted value no longer conflicts",
      !third.conflicts.some((c) => c.field === "weightKg")
    );

    console.log("\nBut genuinely new information is raised again:");
    restore = mockStrava({ id: 1, sex: "F", weight: 62.5, ftp: 300, city: "Evian-les-Bains" });
    const fourth = await prefillAthleteProfile(userId);
    restore();
    check(
      "a changed finding re-opens the question",
      fourth.conflicts.some((c) => c.field === "ftpWatts"),
      fourth.conflicts.map((c) => c.field).join(",")
    );

    console.log("\nTrivial differences are not raised:");
    await resolveSuggestion(userId, "ftpWatts", "dismiss").catch(() => {});
    await updateProfile(userId, { weightKg: 62.6 }); // 0.1 kg from 62.5
    restore = mockStrava({ id: 1, weight: 62.5 });
    const fifth = await prefillAthleteProfile(userId);
    restore();
    check(
      "a 0.1 kg difference is ignored",
      !fifth.conflicts.some((c) => c.field === "weightKg")
    );
    check("matching values are reported as confirmed", fifth.confirmed.length > 0);

    console.log("\nRace location is prefilled from the athlete's home city:");
    await prisma.raceProfile.create({
      data: { userId, raceName: "Triathlon d'Evian" },
    });
    restore = mockStrava({ id: 1, city: "Evian-les-Bains", country: "France" });
    const raceFill = await prefillAthleteProfile(userId);
    restore();
    const race = await prisma.raceProfile.findUnique({ where: { userId } });
    check(
      "race location filled from Strava city",
      race?.location === "Evian-les-Bains, France",
      race?.location ?? "null"
    );
    check(
      "the location fill is reported",
      raceFill.applied.some((a) => a.field === "location")
    );

    // And it must not clobber a location the athlete set.
    await prisma.raceProfile.update({ where: { userId }, data: { location: "Nice, France" } });
    restore = mockStrava({ id: 1, city: "Evian-les-Bains", country: "France" });
    await prefillAthleteProfile(userId);
    restore();
    const race2 = await prisma.raceProfile.findUnique({ where: { userId } });
    check("athlete's own race location is kept", race2?.location === "Nice, France");

    console.log("\nMissing sources fail gracefully:");
    const restoreFail = mockStrava({});
    global.fetch = (async (url: any) => {
      if (String(url).endsWith("/athlete")) {
        return { ok: false, status: 401, text: async () => "Unauthorized" } as any;
      }
      return { ok: true, json: async () => [] } as any;
    }) as any;
    const degraded = await prefillAthleteProfile(userId);
    restoreFail();
    check("a failing source does not crash the prefill", Array.isArray(degraded.applied));
    check("the failure is reported", degraded.errors.length > 0, degraded.errors.join("; "));
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

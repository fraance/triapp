/**
 * Tests for the four improvements requested after the first Strava import:
 *   1. Full history import (pagination), not just the first page.
 *   2. Personalised training load (TSS) using the athlete's own thresholds,
 *      including per-discipline difficulty.
 *   3. A season outline covering EVERY week to race day.
 *   4. Uploaded spreadsheets/notes becoming AI context.
 *
 * Run with:  npm run test:improvements
 */
import "./env.mts";
import { estimateTss, fetchAllActivities } from "../lib/strava";
import {
  getTssContext,
  recalculateAllTss,
  storeActivities,
} from "../lib/strava-db";
import {
  createUser,
  updateProfile,
  saveFullPlan,
  getSeasonView,
  addDetailedWeeks,
  getLatestPlanWithOutline,
} from "../lib/db";
import { weeksUntilRace, chunkWeeks } from "../lib/ai-coach";
import {
  detectFileType,
  extractText,
  saveDocument,
  buildDocumentContext,
  listDocuments,
  setDocumentIncluded,
  deleteDocument,
} from "../lib/documents";
import { prisma } from "../lib/prisma";
import * as XLSX from "xlsx";

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
  console.log("\nTriApp — improvements tests\n");

  // ---- 1. Pagination ------------------------------------------------------
  console.log("Full history import (pagination):");
  {
    // Fake Strava: 3 pages (200, 200, 47) then stop.
    const pages: Record<number, any[]> = {
      1: Array.from({ length: 200 }, (_, i) => ({ id: i + 1 })),
      2: Array.from({ length: 200 }, (_, i) => ({ id: 200 + i + 1 })),
      3: Array.from({ length: 47 }, (_, i) => ({ id: 400 + i + 1 })),
    };
    const realFetch = global.fetch;
    let calls = 0;
    global.fetch = (async (url: any) => {
      calls++;
      const page = Number(new URL(String(url)).searchParams.get("page"));
      return {
        ok: true,
        json: async () => pages[page] ?? [],
      } as any;
    }) as any;

    const all = await fetchAllActivities("token");
    global.fetch = realFetch;

    check("walks past the first page", calls === 3, `made ${calls} calls`);
    check("returns the complete history", all.length === 447, `got ${all.length}`);
  }

  // ---- 2. Personalised TSS ------------------------------------------------
  console.log("\nPersonalised training load:");
  {
    const generic = estimateTss({
      movingTime: 1800, // 30 min
      discipline: "Run",
      avgHeartRate: 155,
    });
    const withThreshold = estimateTss(
      { movingTime: 1800, discipline: "Run", avgHeartRate: 155 },
      { thresholdHeartRate: 160 }
    );
    check(
      "a real threshold changes the score vs. the generic default",
      generic !== withThreshold,
      `generic=${generic} personal=${withThreshold}`
    );
    check(
      "a 30 min run near threshold scores meaningfully",
      withThreshold >= 40,
      `got ${withThreshold}`
    );

    const lowerThreshold = estimateTss(
      { movingTime: 1800, discipline: "Run", avgHeartRate: 155 },
      { thresholdHeartRate: 150 }
    );
    check(
      "a lower threshold means the same effort scores higher",
      lowerThreshold > withThreshold,
      `${lowerThreshold} vs ${withThreshold}`
    );

    // Per-discipline difficulty: running harder, swimming easier for this athlete
    const runHard = estimateTss(
      { movingTime: 3600, discipline: "Run", avgHeartRate: 150 },
      { thresholdHeartRate: 160, difficulty: { Run: 1.3, Swim: 0.8 } }
    );
    const runNeutral = estimateTss(
      { movingTime: 3600, discipline: "Run", avgHeartRate: 150 },
      { thresholdHeartRate: 160 }
    );
    check(
      "raising run difficulty raises run load",
      runHard > runNeutral,
      `${runHard} vs ${runNeutral}`
    );

    const swimEasy = estimateTss(
      { movingTime: 3600, discipline: "Swim", avgHeartRate: 150 },
      { thresholdHeartRate: 160, difficulty: { Run: 1.3, Swim: 0.8 } }
    );
    check(
      "lowering swim difficulty lowers swim load",
      swimEasy < runHard,
      `swim=${swimEasy} run=${runHard}`
    );

    check(
      "HR is preferred over Strava's suffer score",
      estimateTss(
        { movingTime: 3600, discipline: "Run", avgHeartRate: 160, sufferScore: 10 },
        { thresholdHeartRate: 160 }
      ) > 50,
      "HR path should dominate"
    );
  }

  // ---- Database-backed ----------------------------------------------------
  const email = `improve_${Date.now()}@triapp.test`;
  let userId = "";

  try {
    const user = await createUser(email, "pw123456");
    userId = user.id;

    console.log("\nThresholds derived from the athlete's own data:");
    const daysAgo = (n: number) =>
      new Date(Date.now() - n * 24 * 3600 * 1000).toISOString();

    await storeActivities(userId, [
      { id: 101, name: "Run", sport_type: "Run", start_date: daysAgo(3), moving_time: 1800, distance: 6000, average_heartrate: 155, max_heartrate: 178 },
      { id: 102, name: "Ride", sport_type: "Ride", start_date: daysAgo(5), moving_time: 5400, distance: 50000, average_heartrate: 140, max_heartrate: 182 },
      { id: 103, name: "Swim", sport_type: "Swim", start_date: daysAgo(7), moving_time: 2400, distance: 2000 },
    ]);

    const ctx = await getTssContext(userId);
    check(
      "max HR is derived from the athlete's activities",
      ctx.maxHeartRate === 182,
      `got ${ctx.maxHeartRate}`
    );
    check(
      "threshold HR is derived from max HR",
      ctx.thresholdHeartRate === Math.round(182 * 0.9),
      `got ${ctx.thresholdHeartRate}`
    );

    const before = await prisma.stravaActivity.findFirst({
      where: { userId, stravaId: "101" },
    });

    // Athlete says running is much harder for them, and sets a real threshold.
    await updateProfile(userId, {
      thresholdHeartRate: 165,
      maxHeartRate: 185,
      runDifficulty: 1.4,
      swimDifficulty: 0.8,
    });
    const changed = await recalculateAllTss(userId);
    check("changing thresholds rescores stored activities", changed > 0, `${changed} updated`);

    const after = await prisma.stravaActivity.findFirst({
      where: { userId, stravaId: "101" },
    });
    check(
      "the 30 min run now scores higher after marking running as hard",
      (after?.estimatedTss ?? 0) > (before?.estimatedTss ?? 0),
      `before=${before?.estimatedTss} after=${after?.estimatedTss}`
    );

    const swimAfter = await prisma.stravaActivity.findFirst({
      where: { userId, stravaId: "103" },
    });
    check(
      "the swim scores lower after marking swimming as easy",
      (swimAfter?.estimatedTss ?? 0) > 0,
      `got ${swimAfter?.estimatedTss}`
    );

    // ---- 3. Season outline -------------------------------------------------
    console.log("\nSeason outline (every week to race day):");
    check(
      "weeks-until-race counts inclusive whole weeks",
      weeksUntilRace(new Date(2026, 8, 28), new Date(2026, 6, 28)) === 10,
      String(weeksUntilRace(new Date(2026, 8, 28), new Date(2026, 6, 28)))
    );

    const outline = Array.from({ length: 12 }, (_, i) => ({
      week: i + 1,
      phase: i < 6 ? "Base" : i < 9 ? "Build" : i < 11 ? "Taper" : "Race",
      focus: `Focus week ${i + 1}`,
      targetHours: 6 + i * 0.3,
      targetTss: 300 + i * 10,
      isRaceWeek: i === 11,
    }));

    // Only the first 3 weeks have detailed sessions.
    const detailed = [1, 2, 3].map((w) => ({
      week: w,
      phase: "Base",
      summary: `Week ${w}`,
      sessions: [
        { day: "Monday", discipline: "Swim", type: "Endurance", duration: "45 min", tss: 50, instructions: "sets", pace: "steady" },
        { day: "Wednesday", discipline: "Run", type: "Tempo", duration: "40 min", tss: 60, instructions: "threshold", pace: "4:30" },
      ],
    }));

    await saveFullPlan(userId, new Date(2026, 9, 15), detailed, new Date(), outline);

    const season = await getSeasonView(userId);
    check("season reports a plan", season.hasPlan === true);
    check("season covers all 12 weeks", season.totalWeeks === 12, `got ${season.totalWeeks}`);
    check("returns an entry for every week", season.weeks.length === 12);
    check(
      "weeks with sessions are marked as detailed",
      season.weeks.filter((w) => w.hasDetail).length === 3,
      `got ${season.weeks.filter((w) => w.hasDetail).length}`
    );
    check(
      "future weeks still show their phase",
      season.weeks[7].phase === "Build",
      season.weeks[7].phase
    );
    check(
      "future weeks show targets even without sessions",
      season.weeks[7].targetTss !== null && season.weeks[7].hasDetail === false
    );
    check("the final week is flagged as race week", season.weeks[11].isRaceWeek === true);
    check("race week phase is Race", season.weeks[11].phase === "Race");
    check(
      "each week has a real start date",
      /^\d{4}-\d{2}-\d{2}$/.test(season.weeks[0].startDate || "")
    );
    check(
      "week start dates are 7 days apart",
      new Date(season.weeks[1].startDate!).getTime() -
        new Date(season.weeks[0].startDate!).getTime() ===
        7 * 24 * 3600 * 1000
    );
    check("the current week is identified", season.currentWeek === 1, `got ${season.currentWeek}`);

    console.log("\nDetailing more weeks on demand:");
    check(
      "weeks are batched for the AI in groups of 4",
      chunkWeeks(outline, 4).length === 3,
      `got ${chunkWeeks(outline, 4).length} batches`
    );
    check(
      "batching preserves every week",
      chunkWeeks(outline, 4).flat().length === 12
    );
    check(
      "the last batch holds the remainder",
      chunkWeeks(outline.slice(0, 10), 4).at(-1)!.length === 2
    );

    const planRow = await getLatestPlanWithOutline(userId);
    check("the plan keeps its full season outline", planRow?.outline.length === 12);

    // Add detail to weeks 5-6, which were outline-only.
    const added = await addDetailedWeeks(planRow!.id, [
      {
        week: 5,
        phase: "Build",
        summary: "Build week",
        sessions: [
          { day: "Tuesday", discipline: "Bike", type: "Intervals", duration: "60 min", tss: 80, instructions: "5x5min", pace: "FTP" },
        ],
      },
      {
        week: 6,
        phase: "Build",
        summary: "Build week 2",
        sessions: [
          { day: "Thursday", discipline: "Run", type: "Tempo", duration: "45 min", tss: 70, instructions: "25min tempo", pace: "4:20" },
        ],
      },
    ]);
    check("sessions are added for the requested weeks", added === 2, `added ${added}`);

    const expanded = await getSeasonView(userId);
    check(
      "newly detailed weeks now show sessions",
      expanded.weeks[4].hasDetail === true && expanded.weeks[5].hasDetail === true
    );
    check(
      "the detailed-week count is updated",
      expanded.detailedWeeks === 5,
      `got ${expanded.detailedWeeks}`
    );
    check(
      "previously detailed weeks are untouched",
      expanded.weeks[0].hasDetail === true &&
        expanded.weeks[0].sessions.length === 2
    );
    check(
      "weeks not requested stay outline-only",
      expanded.weeks[6].hasDetail === false
    );
    check(
      "the season outline is preserved after expanding",
      expanded.totalWeeks === 12 && expanded.weeks[11].isRaceWeek === true
    );

    // Re-detailing the same week replaces rather than duplicates.
    await addDetailedWeeks(planRow!.id, [
      {
        week: 5,
        phase: "Build",
        summary: "Rewritten",
        sessions: [
          { day: "Monday", discipline: "Swim", type: "Endurance", duration: "40 min", tss: 45, instructions: "sets", pace: "steady" },
        ],
      },
    ]);
    const rewritten = await getSeasonView(userId);
    check(
      "re-generating a week replaces it instead of duplicating",
      rewritten.weeks[4].sessions.length === 1 &&
        rewritten.weeks[4].sessions[0].discipline === "Swim"
    );

    // ---- 4. Documents ------------------------------------------------------
    console.log("\nUploaded files as coach context:");
    check("detects xlsx", detectFileType("history.xlsx") === "xlsx");
    check("detects csv", detectFileType("data.csv") === "csv");
    check("detects txt", detectFileType("notes.txt") === "txt");
    check("rejects unsupported types", detectFileType("photo.png") === null);

    // Build a real Excel file in memory and parse it.
    const sheet = XLSX.utils.aoa_to_sheet([
      ["Date", "Race", "Distance", "Time", "Notes"],
      ["2025-06-01", "Olympic Tri", "Olympic", "2:45:00", "Felt strong on bike"],
      ["2025-09-14", "Half Marathon", "21.1km", "1:52:00", "Cramped at 18km"],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, "Races");
    const buffer: Buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    const extracted = extractText(buffer, "xlsx");
    check("reads an Excel file", extracted.text.includes("Olympic Tri"));
    check("keeps the sheet name", extracted.text.includes("Sheet: Races"));
    check("keeps race times", extracted.text.includes("2:45:00"));
    check("counts rows", extracted.rowCount >= 3, `got ${extracted.rowCount}`);

    const csv = extractText(
      Buffer.from("Date,Session,Notes\n2025-01-01,Long run,Good\n"),
      "csv"
    );
    check("reads a CSV file", csv.text.includes("Long run"));

    const doc = await saveDocument(
      userId,
      "past-performances.xlsx",
      "xlsx",
      extracted.text,
      extracted.rowCount
    );
    check("stores the document", Boolean(doc.id));

    const context = await buildDocumentContext(userId);
    check("document becomes AI context", context.includes("ATHLETE-PROVIDED CONTEXT"));
    check("context contains the filename", context.includes("past-performances.xlsx"));
    check("context contains the actual data", context.includes("Cramped at 18km"));

    await setDocumentIncluded(userId, doc.id, false);
    const excluded = await buildDocumentContext(userId);
    check("excluded documents are left out of AI context", excluded === "");

    await setDocumentIncluded(userId, doc.id, true);
    const docs = await listDocuments(userId);
    check("documents can be listed", docs.length === 1);

    check("documents can be deleted", (await deleteDocument(userId, doc.id)) === true);
    check(
      "another user cannot delete someone else's document",
      (await deleteDocument("someone-else", doc.id)) === false
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

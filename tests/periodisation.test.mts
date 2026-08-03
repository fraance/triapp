/**
 * Periodisation tests.
 *
 * These exist because a plan was generated 70% above what the athlete was
 * actually training, and no downstream adaptation could rescue it: every week
 * breached the ramp guardrail from the moment it was written. The budget has
 * to be right at the point of creation.
 *
 * Run with:  npm run test:periodisation
 */
import "./env.mts";
import {
  buildWeeklyBudgets,
  weeksOverBudget,
  conformWeek,
  DEFAULT_RAMP,
  RECOVERY_FACTOR,
} from "../lib/adaptation/periodisation";

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

console.log("\nTriApp — periodisation tests\n");

console.log("The plan starts where the athlete actually is:");

const b = buildWeeklyBudgets({ totalWeeks: 12, recentWeeklyLoad: 280 });
check("week 1 does not exceed what they are already doing",
  b[0].targetLoad <= 300, `${b[0].targetLoad} vs 280 actual`);
check("every week is covered exactly once",
  b.length === 12 && new Set(b.map((w) => w.week)).size === 12);

const withPeak = buildWeeklyBudgets({
  totalWeeks: 12, recentWeeklyLoad: 280, peakWeeklyLoad: 400,
});
check("a genuine big week allows a slightly higher start",
  withPeak[0].targetLoad > b[0].targetLoad, `${withPeak[0].targetLoad} vs ${b[0].targetLoad}`);
check("but one big week does not become the new baseline",
  withPeak[0].targetLoad < 400, String(withPeak[0].targetLoad));

const cold = buildWeeklyBudgets({ totalWeeks: 12, recentWeeklyLoad: 0 });
check("with no history it starts deliberately low, not at zero",
  cold[0].targetLoad > 0 && cold[0].targetLoad <= 150, String(cold[0].targetLoad));

console.log("\nProgression never breaches the ramp:");

const loading = b.filter((w) => !w.isRecovery && !w.isRaceWeek && w.phase !== "Taper");
let worstJump = 0;
for (let i = 1; i < loading.length; i++) {
  const jump = (loading[i].targetLoad - loading[i - 1].targetLoad) / loading[i - 1].targetLoad;
  worstJump = Math.max(worstJump, jump);
}
check(`no loading week rises more than ${Math.round(DEFAULT_RAMP * 100)}%`,
  worstJump <= DEFAULT_RAMP + 0.001, `worst was ${Math.round(worstJump * 100)}%`);

check("a recovery week appears every fourth week",
  b.filter((w) => w.isRecovery).map((w) => w.week).every((w) => w % 4 === 0),
  JSON.stringify(b.filter((w) => w.isRecovery).map((w) => w.week)));
const recovery = b.find((w) => w.isRecovery)!;
check("and it is genuinely lighter",
  recovery.targetLoad < b[recovery.week - 2].targetLoad * (RECOVERY_FACTOR + 0.05),
  `${recovery.targetLoad} after ${b[recovery.week - 2].targetLoad}`);

check("building resumes from the last loading week, not the deload",
  (() => {
    const after = b.find((w) => w.week === recovery.week + 1);
    return !!after && after.targetLoad > recovery.targetLoad;
  })(), "otherwise every recovery week would permanently cut the plan");

console.log("\nThe end of the plan is shaped like a race:");

check("the last week is race week", b[11].isRaceWeek && b[11].phase === "Race");
check("race week is mostly rest", b[11].targetLoad < b[0].targetLoad * 0.5,
  String(b[11].targetLoad));
const taper = b.filter((w) => w.phase === "Taper");
check("there is a real taper", taper.length === 2, String(taper.length));
check("the taper descends", taper[1].targetLoad < taper[0].targetLoad);
check("phases run Base then Build then Peak",
  b[1].phase === "Base" && b.some((w) => w.phase === "Build") &&
    b.some((w) => w.phase === "Peak"));

const short = buildWeeklyBudgets({ totalWeeks: 3, recentWeeklyLoad: 280 });
check("a very short plan still ends in a race week",
  short[short.length - 1].isRaceWeek, JSON.stringify(short.map((w) => w.phase)));
check("no weeks means no budgets", buildWeeklyBudgets({ totalWeeks: 0, recentWeeklyLoad: 200 }).length === 0);

console.log("\nDeclared time is a ceiling, not a suggestion:");

const capped = buildWeeklyBudgets({
  totalWeeks: 8, recentWeeklyLoad: 600, hoursPerLoad: 0.02, maxWeeklyHours: 6,
});
check("no week exceeds the hours the athlete actually has",
  capped.every((w) => w.targetHours <= 6.01),
  JSON.stringify(capped.map((w) => w.targetHours)));

console.log("\nGenerated weeks are verified, not trusted:");

const over = weeksOverBudget(b, { 1: b[0].targetLoad * 1.5 });
check("a week over budget is caught", over.length === 1 && over[0].week === 1);
check("and by how much", over[0].overBy > 0);
check("a week inside budget passes",
  weeksOverBudget(b, { 1: b[0].targetLoad }).length === 0);
check("small overshoots are tolerated",
  weeksOverBudget(b, { 1: b[0].targetLoad * 1.02 }).length === 0);

const sessions = [{ tss: 100 }, { tss: 50 }, { tss: 0 }, { tss: 50 }];
const conformed = conformWeek(sessions, 100);
check("an over-budget week is scaled back to its target",
  conformed.reduce((n, s) => n + s.tss, 0) <= 101,
  String(conformed.reduce((n, s) => n + s.tss, 0)));
check("the shape of the week is preserved",
  conformed[0].tss > conformed[1].tss,
  "the hard session must stay the hard session");
check("rest days stay at zero", conformed[2].tss === 0);
check("a week inside budget is left alone",
  conformWeek(sessions, 500)[0].tss === 100);

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);

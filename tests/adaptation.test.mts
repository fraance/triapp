/**
 * Adaptation engine tests (Phase 1).
 *
 * The engine's whole value is that it can be trusted to change a training plan
 * without supervision, so these tests are deliberately adversarial: they check
 * that it refuses to do dangerous things, not just that it does useful ones.
 *
 * Covers:
 *   1. Load vectors — run vs bike vs swim cost different things.
 *   2. Guardrails — ramp, ACWR, key-session separation, anchors, illness.
 *   3. Execution drift — overshoot constrains, undershoot only suggests.
 *   4. Missed-session salvage scoring.
 *   5. Solver — deterministic, obeys guardrails, respects the freeze window.
 *   6. Hysteresis and the commitment window.
 *   7. End-to-end against a throwaway account.
 *
 * Never touches real athlete data: the integration section creates and deletes
 * its own user (project rule 3).
 *
 * Run with:  npm run test:adaptation
 */
import "./env.mts";
import {
  loadVectorFor,
  totalLoad,
  ewma,
  acwr,
  dailySeries,
  sumLoad,
  normaliseDiscipline,
  intensityFromType,
} from "../lib/adaptation/load-vector";
import {
  checkGuardrails,
  isKeySession,
  DEFAULT_LIMITS,
} from "../lib/adaptation/guardrails";
import {
  executionDriftEngine,
  salvageEngine,
  fatiguePressure,
} from "../lib/adaptation/signals";
import { solve, scorePlan, hardViolations } from "../lib/adaptation/solver";
import {
  freezeBoundary,
  diffPlans,
  adaptPlanForUser,
} from "../lib/adaptation/engine";
import { describeChanges } from "../lib/adaptation/narrator";
import { reconcilePlanWithActivities, dailyPlannedVsActual } from "../lib/adaptation/reconcile";
import { planNextWeek, selectAnchors, RECOVERY_WEEK_FACTOR } from "../lib/adaptation/macro-planner";
import { crossSportSwapEngine } from "../lib/adaptation/signals";
import {
  analyseLimiters,
  distancesFor,
  describeLimiters,
} from "../lib/adaptation/limiter";
import { MIN_CHRONIC_HISTORY_DAYS } from "../lib/adaptation/guardrails";
import {
  weeklyHoursFrom,
  hoursOn,
  fitsOn,
  datesThatFit,
  unavailableDates,
  preferredLongDates,
} from "../lib/adaptation/availability-window";
import { SolverSession, ZERO_LOAD } from "../lib/adaptation/types";
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

function session(
  over: Partial<SolverSession> & { id: string; date: string }
): SolverSession {
  const discipline = over.discipline ?? "Run";
  const tss = over.tss ?? 50;
  return {
    discipline,
    type: over.type ?? "Endurance",
    durationMinutes: over.durationMinutes ?? 60,
    tss,
    load: over.load ?? loadVectorFor({ discipline, tss, type: over.type ?? "Endurance" }),
    purpose: over.purpose ?? "Endurance",
    isAnchor: over.isAnchor ?? false,
    status: over.status ?? "planned",
    ...over,
  } as SolverSession;
}

async function main() {
  console.log("\nTriApp — adaptation engine tests\n");

  // ======================================================================
  console.log("Load is split by what it actually costs:");

  const run = loadVectorFor({ discipline: "Run", tss: 100, type: "Endurance" });
  const bike = loadVectorFor({ discipline: "Bike", tss: 100, type: "Endurance" });
  const swim = loadVectorFor({ discipline: "Swim", tss: 100, type: "Endurance" });

  check("a run costs more mechanically than a ride", run.mechanical > bike.mechanical,
    `run ${run.mechanical} vs bike ${bike.mechanical}`);
  check("a ride costs more metabolically than a run", bike.metabolic > run.metabolic);
  check("only swimming loads the upper body", swim.upper > 0 && run.upper === 0 && bike.upper === 0);
  check("equal TSS still totals roughly the same", Math.abs(totalLoad(run) - totalLoad(bike)) < 5,
    `${totalLoad(run)} vs ${totalLoad(bike)}`);

  const easy = loadVectorFor({ discipline: "Run", tss: 100, type: "Recovery" });
  const hard = loadVectorFor({ discipline: "Run", tss: 100, type: "VO2 Intervals" });
  check("intervals cost far more neuromuscularly than recovery",
    hard.neuromuscular > easy.neuromuscular * 2,
    `${hard.neuromuscular} vs ${easy.neuromuscular}`);

  check("a rest day has no load", totalLoad(loadVectorFor({ discipline: "Rest", tss: 0 })) === 0);
  check("an unknown intensity is not invented", intensityFromType("Squiggle") === null);
  check("disciplines normalise", normaliseDiscipline("Virtual Ride") === "bike" &&
    normaliseDiscipline("Open Water Swim") === "swim");

  const hilly = loadVectorFor({ discipline: "Run", tss: 100, type: "Endurance", distanceKm: 10, elevationGainM: 500 });
  check("a hilly run adds eccentric damage", hilly.mechanical > run.mechanical,
    `${hilly.mechanical} vs ${run.mechanical}`);

  // ======================================================================
  console.log("\nRolling load maths:");

  const flat = Array.from({ length: 42 }, () => ({ metabolic: 10, mechanical: 5, neuromuscular: 2, upper: 0 }));
  const chronic = ewma(flat, 42);
  check("EWMA of a steady load converges below the daily value",
    chronic.metabolic > 0 && chronic.metabolic < 10);
  check("EWMA of nothing is zero", totalLoad(ewma([], 42)) === 0);

  const ratios = acwr({ metabolic: 20, mechanical: 10, neuromuscular: 4, upper: 0 },
                      { metabolic: 10, mechanical: 10, neuromuscular: 2, upper: 0 });
  check("ACWR divides acute by chronic", ratios.metabolic === 2);
  check("zero chronic load yields 0, not Infinity", ratios.upper === 0);

  const series = dailySeries(
    [{ date: "2026-07-27", load: { metabolic: 10, mechanical: 0, neuromuscular: 0, upper: 0 } }],
    "2026-07-27", "2026-07-30");
  check("rest days appear as zeros in the series", series.length === 4 && totalLoad(series[1]) === 0);

  // ======================================================================
  console.log("\nGuardrails cannot be argued with:");

  const prevWeek = { metabolic: 200, mechanical: 100, neuromuscular: 40, upper: 20 };
  const chronicCtx = { metabolic: 30, mechanical: 15, neuromuscular: 6, upper: 3 };

  const spike = [
    session({ id: "a", date: "2026-08-03", tss: 200, discipline: "Run" }),
    session({ id: "b", date: "2026-08-05", tss: 200, discipline: "Bike" }),
  ];
  const rampViolations = checkGuardrails(spike, { chronicLoad: chronicCtx, previousWeekLoad: prevWeek });
  check("a big week-on-week jump is blocked",
    rampViolations.some((v) => v.rule === "weekly_ramp" || v.rule === "acwr_block"),
    JSON.stringify(rampViolations.map((v) => v.rule)));

  const twoHardRuns = [
    session({ id: "k1", date: "2026-08-03", tss: 90, discipline: "Run", type: "Threshold", isAnchor: true }),
    session({ id: "k2", date: "2026-08-04", tss: 90, discipline: "Run", type: "Threshold", isAnchor: true }),
  ];
  check("two key sessions loading the same system within 48h are blocked",
    checkGuardrails(twoHardRuns, { chronicLoad: ZERO_LOAD, previousWeekLoad: ZERO_LOAD })
      .some((v) => v.rule === "key_session_separation"));

  const runThenBike = [
    session({ id: "r", date: "2026-08-03", tss: 95, discipline: "Run", type: "Threshold", isAnchor: true }),
    session({ id: "c", date: "2026-08-04", tss: 95, discipline: "Bike", type: "Threshold", isAnchor: true }),
  ];
  check("a hard run directly before a hard bike is blocked",
    checkGuardrails(runThenBike, { chronicLoad: ZERO_LOAD, previousWeekLoad: ZERO_LOAD })
      .some((v) => v.rule === "run_before_bike"));

  const droppedAnchor = [session({ id: "x", date: "2026-08-03", isAnchor: true, dropped: true })];
  check("an anchor session may never be dropped",
    checkGuardrails(droppedAnchor, { chronicLoad: ZERO_LOAD, previousWeekLoad: ZERO_LOAD })
      .some((v) => v.rule === "anchor_dropped"));

  check("illness suspends all training",
    checkGuardrails([session({ id: "s", date: "2026-08-03", tss: 30 })],
      { chronicLoad: ZERO_LOAD, previousWeekLoad: ZERO_LOAD, suspended: true })
      .some((v) => v.rule === "illness_suspension"));

  check("a sane plan passes cleanly",
    checkGuardrails(
      [session({ id: "ok", date: "2026-08-03", tss: 40, type: "Recovery" })],
      { chronicLoad: chronicCtx, previousWeekLoad: prevWeek }
    ).length === 0);

  check("a hard session counts as key", isKeySession(session({ id: "h", date: "2026-08-03", tss: 90, type: "VO2 Intervals" })));
  check("an easy session does not", !isKeySession(session({ id: "e", date: "2026-08-03", tss: 25, type: "Recovery" })));

  // ======================================================================
  console.log("\nExecution drift reacts to what was actually done:");

  const planned = loadVectorFor({ discipline: "Bike", tss: 80, type: "Endurance" });
  const overshot = loadVectorFor({ discipline: "Bike", tss: 130, type: "Threshold" });

  const over = executionDriftEngine(
    [{ date: "2026-07-29", discipline: "Bike", actualLoad: overshot, plannedLoad: planned }],
    "2026-07-30");
  check("a hard overshoot emits a hard constraint",
    over.constraints.some((c) => c.type === "hard"), JSON.stringify(over.facts));
  check("the constraint explains itself in plain English",
    (over.constraints[0]?.reason ?? "").length > 20);
  check("the drift percentage is recorded", typeof (over.facts as any)?.totalDriftPct === "number");

  const under = executionDriftEngine(
    [{ date: "2026-07-29", discipline: "Bike", actualLoad: loadVectorFor({ discipline: "Bike", tss: 20 }), plannedLoad: planned }],
    "2026-07-30");
  check("an undershoot never emits a hard constraint",
    under.constraints.every((c) => c.type === "soft"),
    "undershooting must not be able to force load up");

  const onPlan = executionDriftEngine(
    [{ date: "2026-07-29", discipline: "Bike", actualLoad: planned, plannedLoad: planned }],
    "2026-07-30");
  check("training on plan changes nothing", onPlan.constraints.length === 0);

  const noBaseline = executionDriftEngine(
    [{ date: "2026-07-29", discipline: "Bike", actualLoad: overshot }], "2026-07-30");
  check("with nothing planned, no drift is claimed",
    noBaseline.constraints.length === 0 && (noBaseline.facts as any).comparable === false);

  check("no recent training means no constraints",
    executionDriftEngine([], "2026-07-30").constraints.length === 0);

  // ======================================================================
  console.log("\nMissed sessions are triaged, not blindly crammed back in:");

  const salvage = salvageEngine([
    { id: "m1", date: "2026-07-29", discipline: "run", purpose: "Threshold", isAnchor: true, load: ZERO_LOAD },
    { id: "m2", date: "2026-07-29", discipline: "swim", purpose: "Recovery", isAnchor: false, load: ZERO_LOAD },
  ], { fatiguePressure: 0.2 });

  check("a key threshold session is rescheduled", salvage[0].action === "reschedule", JSON.stringify(salvage[0]));
  check("an easy recovery swim is not chased", salvage[1].action !== "reschedule", JSON.stringify(salvage[1]));
  check("every decision carries a reason", salvage.every((s) => s.reason.length > 10));

  const tired = salvageEngine(
    [{ id: "m3", date: "2026-07-29", discipline: "run", purpose: "Endurance", isAnchor: false, load: ZERO_LOAD }],
    { fatiguePressure: 1 });
  const fresh = salvageEngine(
    [{ id: "m3", date: "2026-07-29", discipline: "run", purpose: "Endurance", isAnchor: false, load: ZERO_LOAD }],
    { fatiguePressure: 0 });
  check("fatigue lowers the case for catching up", tired[0].score < fresh[0].score);

  check("fatigue pressure is 0..1", (() => {
    const p = fatiguePressure({ metabolic: 40, mechanical: 20, neuromuscular: 8, upper: 0 },
                              { metabolic: 20, mechanical: 10, neuromuscular: 4, upper: 0 });
    return p >= 0 && p <= 1;
  })());
  check("unknown chronic load gives a neutral 0.5", fatiguePressure(ZERO_LOAD, ZERO_LOAD) === 0.5);

  // ======================================================================
  console.log("\nThe solver is deterministic and obeys its limits:");

  const base = {
    today: "2026-07-30",
    chronicLoad: { metabolic: 40, mechanical: 20, neuromuscular: 8, upper: 5 },
    preferences: [],
    constraints: [],
  };

  const plan = [
    session({ id: "s1", date: "2026-07-31", tss: 60, discipline: "Bike" }),
    session({ id: "s2", date: "2026-08-01", tss: 70, discipline: "Run" }),
    session({ id: "s3", date: "2026-08-02", tss: 40, discipline: "Swim" }),
  ];
  const guard = { chronicLoad: base.chronicLoad, previousWeekLoad: { metabolic: 150, mechanical: 80, neuromuscular: 30, upper: 20 } };

  const a1 = solve({ ...base, sessions: plan } as any, { guardrails: guard });
  const a2 = solve({ ...base, sessions: plan } as any, { guardrails: guard });
  check("identical input gives identical output",
    JSON.stringify(a1.sessions) === JSON.stringify(a2.sessions));
  check("with no constraints the plan is left alone",
    diffPlans(plan, a1.sessions).empty, JSON.stringify(diffPlans(plan, a1.sessions).changes));

  const capped = solve({
    ...base,
    sessions: plan,
    constraints: [{
      kind: "cap_load", type: "hard", source: "test",
      reason: "capped", fromDate: "2026-07-30", toDate: "2026-08-01", factor: 0.5,
    }],
  } as any, { guardrails: guard });
  const cappedDiff = diffPlans(plan, capped.sessions);
  check("a hard load cap forces a change", !cappedDiff.empty, JSON.stringify(cappedDiff.changes));
  check("the resulting plan breaks no hard constraint",
    hardViolations(capped.sessions, {
      ...base,
      sessions: plan,
      constraints: [{ kind: "cap_load", type: "hard", source: "test", reason: "capped",
        fromDate: "2026-07-30", toDate: "2026-08-01", factor: 0.5 }],
    } as any).length === 0);

  const frozen = solve({
    ...base,
    sessions: plan,
    frozenUntil: "2026-08-01",
    constraints: [{
      kind: "cap_load", type: "hard", source: "test",
      reason: "capped", fromDate: "2026-07-30", toDate: "2026-08-01", factor: 0.5,
    }],
  } as any, { guardrails: guard });
  const movedInsideFreeze = diffPlans(plan, frozen.sessions).changes
    .filter((c) => (c.fromDate ?? "") <= "2026-08-01" && c.change === "moved");
  check("sessions inside the commitment window are never moved",
    movedInsideFreeze.length === 0, JSON.stringify(movedInsideFreeze));

  const anchored = [
    session({ id: "k", date: "2026-08-02", tss: 120, discipline: "Run", isAnchor: true }),
  ];
  const anchorResult = solve({
    ...base,
    sessions: anchored,
    constraints: [{ kind: "cap_load", type: "hard", source: "test", reason: "cap", factor: 0.5 }],
  } as any, { guardrails: guard });
  check("an anchor is scaled rather than dropped",
    !anchorResult.sessions[0].dropped, "anchors must survive every adaptation");

  const scoreA = scorePlan(plan, { ...base, sessions: plan } as any);
  const scoreMoved = scorePlan(
    plan.map((s, i) => (i === 0 ? { ...s, date: "2026-08-04", movedFrom: s.date } : s)),
    { ...base, sessions: plan } as any);
  check("moving a session costs stability", scoreMoved.stability < scoreA.stability);

  // ======================================================================
  console.log("\nCommitment window:");

  check("before 20:00 only today is frozen",
    freezeBoundary(new Date("2026-07-30T18:00:00")) === "2026-07-30");
  check("after 20:00 tomorrow locks too",
    freezeBoundary(new Date("2026-07-30T21:00:00")) === "2026-07-31");

  // ======================================================================
  console.log("\nExplanations never invent anything:");

  const text = describeChanges({
    trigger: "execution_drift",
    constraints: [{ kind: "cap_load", type: "hard", source: "execution_drift", reason: "Yesterday's ride was 25% harder than planned." }],
    diff: { empty: false, changes: [{ sessionId: "s1", discipline: "Run", change: "scaled", fromDate: "2026-07-31", toDate: "2026-07-31", fromTss: 70, toTss: 40 }] },
  });
  check("the fallback explanation states cause and action",
    text.includes("harder than planned") && text.includes("Run"), text);
  check("no changes means no story",
    describeChanges({ trigger: "t", constraints: [], diff: { empty: true, changes: [] } }) === "No changes were needed.");

  // ======================================================================
  console.log("\nv3 §4.3 — declared availability, not a weekend guess:");

  // The CEO's placeholder profile: Mon-Thu 1h, Fri 0h, Sat 3h, Sun 4h.
  const mock = weeklyHoursFrom({
    noTimeConstraints: false,
    monHours: 1, tueHours: 1, wedHours: 1, thuHours: 1,
    friHours: 0, satHours: 3, sunHours: 4,
    longSessionDay: "Sunday",
  });

  // 2026-08-03 is a Monday.
  check("hours are read from the declared day, not assumed",
    hoursOn(mock, "2026-08-03") === 1 && hoursOn(mock, "2026-08-08") === 3 &&
    hoursOn(mock, "2026-08-09") === 4,
    `mon ${hoursOn(mock, "2026-08-03")} sat ${hoursOn(mock, "2026-08-08")} sun ${hoursOn(mock, "2026-08-09")}`);
  check("a day with zero hours has none", hoursOn(mock, "2026-08-07") === 0);

  check("a 3h session cannot go on a 1h Monday", !fitsOn(mock, "2026-08-03", 180));
  check("a 3h session fits Saturday", fitsOn(mock, "2026-08-08", 180));
  check("a 45min session fits a 1h weekday", fitsOn(mock, "2026-08-03", 45));
  check("a session never fits a zero-hour Friday", !fitsOn(mock, "2026-08-07", 30));

  const longSlots = datesThatFit(mock, "2026-08-03", 7, 180);
  check("only genuinely long-enough days can host a 3h session",
    longSlots.every((d) => ["2026-08-08", "2026-08-09"].includes(d)) && longSlots.length === 2,
    JSON.stringify(longSlots));

  const fourHour = datesThatFit(mock, "2026-08-03", 7, 240);
  check("a 4h session fits only Sunday", JSON.stringify(fourHour) === '["2026-08-09"]',
    JSON.stringify(fourHour));

  check("zero-hour days are reported as unavailable",
    JSON.stringify(unavailableDates(mock, "2026-08-03", 7)) === '["2026-08-07"]',
    JSON.stringify(unavailableDates(mock, "2026-08-03", 7)));

  check("a stated long-session day is preferred when it fits",
    JSON.stringify(preferredLongDates(mock, "2026-08-03", 7, 180)) === '["2026-08-09"]',
    JSON.stringify(preferredLongDates(mock, "2026-08-03", 7, 180)));

  // Never invent a limit the athlete has not given us (project rule 2).
  const undeclared = weeklyHoursFrom(null);
  check("an athlete who declared nothing is never blocked",
    hoursOn(undeclared, "2026-08-03") === null && fitsOn(undeclared, "2026-08-03", 300));
  check("no declaration means no unavailable days",
    unavailableDates(undeclared, "2026-08-03", 7).length === 0);

  const noLimits = weeklyHoursFrom({
    noTimeConstraints: true,
    monHours: 0, tueHours: 0, wedHours: 0, thuHours: 0,
    friHours: 0, satHours: 0, sunHours: 0,
  });
  check("'no time constraints' means everything fits",
    fitsOn(noLimits, "2026-08-03", 600) && noLimits.isSet);

  console.log("\nThe solver honours declared availability:");

  const availBase = {
    today: "2026-08-03",
    chronicLoad: { metabolic: 40, mechanical: 20, neuromuscular: 8, upper: 5 },
    preferences: [], constraints: [],
    availableMinutesByDate: {
      "2026-08-03": 60, "2026-08-04": 60, "2026-08-05": 60, "2026-08-06": 60,
      "2026-08-07": 0, "2026-08-08": 180, "2026-08-09": 240,
    },
    unavailableDates: ["2026-08-07"],
    longSessionDates: ["2026-08-09"],
  };
  const availGuard = {
    chronicLoad: availBase.chronicLoad,
    previousWeekLoad: { metabolic: 150, mechanical: 80, neuromuscular: 30, upper: 20 },
    chronicHistoryDays: 60,
    longSessionDates: ["2026-08-09"],
  };

  const overbooked = [
    session({ id: "big", date: "2026-08-04", tss: 70, discipline: "Bike",
      durationMinutes: 150 }),
  ];
  check("a session longer than the day allows is a hard violation",
    hardViolations(overbooked, { ...availBase, sessions: overbooked } as any).length > 0,
    "150 min cannot fit a 60 min Tuesday");

  const onFriday = [
    session({ id: "fri", date: "2026-08-07", tss: 40, discipline: "Swim",
      durationMinutes: 45 }),
  ];
  check("training is not scheduled on a zero-hour day",
    hardViolations(onFriday, { ...availBase, sessions: onFriday } as any).length > 0);

  const longOnSunday = [
    session({ id: "lng", date: "2026-08-09", tss: 130, discipline: "Run",
      type: "Long", durationMinutes: 210, isLong: true }),
    session({ id: "wd", date: "2026-08-04", tss: 60, discipline: "Bike",
      durationMinutes: 55 }),
  ];
  const availResult = solve(
    { ...availBase, sessions: longOnSunday,
      constraints: [{ kind: "cap_load", type: "hard", source: "test", reason: "cap", factor: 0.6 }],
    } as any,
    { guardrails: availGuard });
  const availChanges = diffPlans(longOnSunday, availResult.sessions);
  check("the long session is never moved onto a weekday that cannot hold it",
    !availChanges.changes.some((c) => c.sessionId === "lng" && c.change === "moved"),
    JSON.stringify(availChanges.changes));
  const scaledFit = solve(
    { ...availBase,
      sessions: [session({ id: "toolong", date: "2026-08-04", tss: 90,
        discipline: "Bike", durationMinutes: 120 })],
    } as any,
    { guardrails: availGuard });
  check("easing a session shortens it, so it can fit the time available",
    scaledFit.sessions[0].durationMinutes <= 60,
    `${scaledFit.sessions[0].durationMinutes} min`);
  check("the shortened session no longer breaches the day's limit",
    hardViolations(scaledFit.sessions,
      { ...availBase, sessions: scaledFit.sessions } as any).length === 0,
    JSON.stringify(hardViolations(scaledFit.sessions, { ...availBase, sessions: scaledFit.sessions } as any)));

  check("weekday volume is trimmed instead",
    availChanges.changes.some((c) => c.sessionId === "wd") ||
      availChanges.changes.length === 0,
    JSON.stringify(availChanges.changes));

  // ======================================================================
  console.log("\nv3 §4.3 — real life anchors long sessions:");

  const longPlan = [
    session({ id: "long", date: "2026-08-01", tss: 120, discipline: "Run",
      type: "Long", durationMinutes: 150, isLong: true }),
    session({ id: "week", date: "2026-08-04", tss: 60, discipline: "Bike" }),
  ];
  const longGuard = {
    chronicLoad: { metabolic: 40, mechanical: 20, neuromuscular: 8, upper: 5 },
    previousWeekLoad: { metabolic: 150, mechanical: 80, neuromuscular: 30, upper: 20 },
    chronicHistoryDays: 60,
    longSessionDates: ["2026-08-01", "2026-08-02"],
  };
  const longBase = {
    today: "2026-07-31", chronicLoad: longGuard.chronicLoad,
    preferences: [], constraints: [
      { kind: "cap_load", type: "hard", source: "test", reason: "cap", factor: 0.6 },
    ],
  };
  const longResult = solve({ ...longBase, sessions: longPlan } as any, { guardrails: longGuard });
  const longChanges = diffPlans(longPlan, longResult.sessions);
  check("a long session is never moved",
    !longChanges.changes.some((c) => c.sessionId === "long" && c.change === "moved"),
    JSON.stringify(longChanges.changes));
  check("a long session is never dropped",
    !longResult.sessions.find((x) => x.id === "long")?.dropped);
  check("weekday volume is trimmed before the long session",
    (() => {
      const w = longChanges.changes.find((c) => c.sessionId === "week");
      const l = longChanges.changes.find((c) => c.sessionId === "long");
      return !!w || !l;
    })(), JSON.stringify(longChanges.changes));
  check("moving a long session off an allowed day is blocked",
    checkGuardrails(
      [{ ...longPlan[0], date: "2026-08-05", movedFrom: "2026-08-01" }],
      longGuard as any
    ).some((v) => v.rule === "long_session_moved" || v.rule === "long_session_day"));

  console.log("\nv3 §5 — the ACWR cold-start trap:");

  const spikySessions = [session({ id: "cs", date: "2026-08-03", tss: 200, discipline: "Bike" })];
  const coldStart = checkGuardrails(spikySessions, {
    chronicLoad: { metabolic: 3, mechanical: 1, neuromuscular: 1, upper: 0 },
    previousWeekLoad: ZERO_LOAD,
    chronicHistoryDays: 10,
    dailyLoadCeiling: 250,
  });
  check("with under 28 days of history ACWR is ignored",
    !coldStart.some((v) => v.rule === "acwr_block"),
    "a thin denominator would otherwise zero out the week");
  check("a daily ceiling governs instead",
    checkGuardrails(
      [session({ id: "cs2", date: "2026-08-03", tss: 400, discipline: "Bike" })],
      { chronicLoad: ZERO_LOAD, previousWeekLoad: ZERO_LOAD,
        chronicHistoryDays: 10, dailyLoadCeiling: 100 }
    ).some((v) => v.rule === "daily_ceiling"));
  check("with a full history ACWR applies again",
    checkGuardrails(spikySessions, {
      chronicLoad: { metabolic: 3, mechanical: 1, neuromuscular: 1, upper: 0 },
      previousWeekLoad: ZERO_LOAD,
      chronicHistoryDays: MIN_CHRONIC_HISTORY_DAYS,
    }).some((v) => v.rule === "acwr_block"));

  console.log("\nv3 §5 — cross-sport swap penalty:");

  const ranInsteadOfSwam = crossSportSwapEngine(
    [{ date: "2026-07-30", plannedDiscipline: "Swim", actualDiscipline: "Run" }],
    "2026-07-31");
  check("running instead of swimming restricts the legs",
    ranInsteadOfSwam.constraints.some(
      (c) => c.type === "hard" && c.component === "mechanical"),
    JSON.stringify(ranInsteadOfSwam.facts));
  check("the restriction lasts 48 hours",
    ranInsteadOfSwam.constraints[0]?.toDate === "2026-08-02",
    ranInsteadOfSwam.constraints[0]?.toDate);

  const swamInsteadOfRan = crossSportSwapEngine(
    [{ date: "2026-07-30", plannedDiscipline: "Run", actualDiscipline: "Swim" }],
    "2026-07-31");
  check("swapping to a lower-impact sport costs the legs nothing",
    swamInsteadOfRan.constraints.length === 0,
    "penalising every swap equally would needlessly suppress training");
  check("no swaps means no constraints",
    crossSportSwapEngine([], "2026-07-31").constraints.length === 0);

  // ======================================================================
  console.log("\nWeekly intent — load debt is forgiven, never repaid:");

  const wk = (weekStart: string, plannedLoad: number, actualLoad: number) =>
    ({ weekStart, plannedLoad, actualLoad });

  const macroUnder = planNextWeek({
    history: [wk("2026-07-20", 400, 300)],
    chronicLoad: ZERO_LOAD, nextWeekPlanned: 420, nextWeekStart: "2026-08-03",
  });
  check("training under plan never raises next week's target",
    macroUnder.targetLoad <= 420, `target ${macroUnder.targetLoad}`);
  check("a single under-week changes nothing", macroUnder.action === "hold", macroUnder.action);
  check("the athlete is told the debt is forgiven", /forgiven/i.test(macroUnder.reason));

  const chronicShortfall = planNextWeek({
    history: [wk("2026-07-13", 400, 240), wk("2026-07-20", 400, 250)],
    chronicLoad: ZERO_LOAD, nextWeekPlanned: 420, nextWeekStart: "2026-08-03",
  });
  check("two weeks far below plan brings the PLAN down, not the athlete up",
    chronicShortfall.action === "downgrade_plan", chronicShortfall.action);
  check("the downgraded target lands near what is actually sustained",
    chronicShortfall.targetLoad < 420 && chronicShortfall.targetLoad > 200,
    String(chronicShortfall.targetLoad));

  const macroOver = planNextWeek({
    history: [wk("2026-07-20", 300, 420)],
    chronicLoad: ZERO_LOAD, nextWeekPlanned: 320, nextWeekStart: "2026-08-03",
  });
  check("a big overshoot tightens the coming week",
    ["tighten", "recovery_week"].includes(macroOver.action), macroOver.action);
  check("tightening lowers the target", macroOver.targetLoad < 320, String(macroOver.targetLoad));
  check("the cap is a hard constraint",
    macroOver.constraints.some((c) => c.type === "hard" && c.kind === "cap_load"));
  check("the cap is an absolute ceiling, not a per-session factor",
    macroOver.constraints.every((c) => c.limit !== undefined));

  const rampBreach = planNextWeek({
    history: [wk("2026-07-13", 300, 300), wk("2026-07-20", 320, 400)],
    chronicLoad: ZERO_LOAD, nextWeekPlanned: 430, nextWeekStart: "2026-08-03",
  });
  check("breaching the ramp pulls the recovery week forward",
    rampBreach.action === "recovery_week", rampBreach.action);
  check("the recovery week sits well below the last week's load",
    rampBreach.targetLoad <= 400 * RECOVERY_WEEK_FACTOR + 1, String(rampBreach.targetLoad));

  const noHistory = planNextWeek({
    history: [], chronicLoad: ZERO_LOAD, nextWeekPlanned: 300, nextWeekStart: "2026-08-03",
  });
  check("with no history the plan is left alone", noHistory.action === "hold");
  check("no history means no invented constraints", noHistory.constraints.length === 0);

  console.log("\nv3 §3.1 — limiter analysis by race-course ROI:");

  // Measured capability: ~2:00/100m swim, ~28 km/h ride, ~5:00/km threshold.
  const cap = {
    swimCssSecPer100: 120,
    bikeSpeedMs: 7.8,
    runThresholdPaceSec: 300,
  };

  const olympic = analyseLimiters(cap, { raceType: "Olympic" });
  check("distances are resolved from the race type",
    distancesFor("70.3")?.bikeKm === 90 && distancesFor("Olympic")?.runKm === 10);
  check("an unknown race distance yields no analysis",
    !analyseLimiters(cap, { raceType: "Adventure Dash" }).hasData);
  check("every discipline gets a predicted split",
    olympic.estimates.every((e) => e.predictedSec !== null), JSON.stringify(olympic.estimates));

  check("the bike is the biggest lever on an Olympic course",
    olympic.ranked[0] === "bike", JSON.stringify(olympic.ranked));
  check("ROI shares add up to about 1",
    Math.abs(olympic.estimates.reduce((n, e) => n + e.roi, 0) - 1) < 0.02,
    String(olympic.estimates.reduce((n, e) => n + e.roi, 0)));

  const long = analyseLimiters(cap, { raceType: "70.3" });
  const olyBike = olympic.estimates.find((e) => e.discipline === "bike")!;
  const longBike = long.estimates.find((e) => e.discipline === "bike")!;
  check("the longer the race, the more a bike gain is worth",
    (longBike.minutesPer5Pct ?? 0) > (olyBike.minutesPer5Pct ?? 0),
    `${longBike.minutesPer5Pct} vs ${olyBike.minutesPer5Pct}`);

  const mountainous = analyseLimiters(cap, {
    raceType: "70.3", bikeElevationGainM: 2000,
  });
  const flatBikeSec = long.estimates.find((e) => e.discipline === "bike")!.predictedSec!;
  const hillyBikeSec = mountainous.estimates.find((e) => e.discipline === "bike")!.predictedSec!;
  check("a mountainous course slows the predicted bike split",
    hillyBikeSec > flatBikeSec, `${hillyBikeSec} vs ${flatBikeSec}`);
  check("and raises the bike's share of the available gain",
    mountainous.priority.bike > long.priority.bike,
    `${mountainous.priority.bike} vs ${long.priority.bike}`);

  const openWater = analyseLimiters(cap, { raceType: "Olympic", swimEnvironment: "lake" });
  const pool = analyseLimiters(cap, { raceType: "Olympic", swimEnvironment: "pool" });
  check("open water is slower than pool-equivalent pace",
    openWater.estimates[0].predictedSec! > pool.estimates[0].predictedSec!);
  const wetsuit = analyseLimiters(cap, {
    raceType: "Olympic", swimEnvironment: "lake", wetsuitLikely: true,
  });
  check("a wetsuit claws some of that back",
    wetsuit.estimates[0].predictedSec! < openWater.estimates[0].predictedSec!);

  const trail = analyseLimiters(cap, { raceType: "Olympic", runSurface: "trail" });
  check("trail running is slower than road",
    trail.estimates[2].predictedSec! > olympic.estimates[2].predictedSec!);

  // Never invent what has not been measured (project rule 2).
  const partial = analyseLimiters(
    { swimCssSecPer100: null, bikeSpeedMs: 7.8, runThresholdPaceSec: 300 },
    { raceType: "Olympic" });
  check("an unmeasured discipline is excluded, not estimated",
    partial.estimates.find((e) => e.discipline === "swim")!.predictedSec === null &&
    !partial.ranked.includes("swim"),
    JSON.stringify(partial.ranked));
  check("and the athlete is told why",
    partial.notes.some((n) => n.includes("swim")), JSON.stringify(partial.notes));
  check("a total is not claimed when a segment is unknown",
    partial.predictedTotalSec === null);
  check("the remaining disciplines still rank",
    partial.ranked.length === 2);

  check("without a goal time no deficit is invented",
    olympic.estimates.every((e) => e.deficitSec === null) &&
    olympic.notes.some((n) => n.includes("No goal time")));

  const withGoal = analyseLimiters(cap, { raceType: "Olympic" }, { goalTimeSec: 9000 });
  check("with a goal time, the shortfall per discipline is reported",
    withGoal.estimates.every((e) => e.deficitSec !== null),
    JSON.stringify(withGoal.estimates.map((e) => e.deficitSec)));

  check("the summary names the biggest lever",
    describeLimiters(olympic).includes("bike"), describeLimiters(olympic));
  check("analysis is deterministic",
    JSON.stringify(analyseLimiters(cap, { raceType: "Olympic" })) === JSON.stringify(olympic));

  console.log("\nAnchors follow the limiter, not just the hardest session:");

  const roiAnchors = selectAnchors(
    [
      { id: "swim-hard", discipline: "Swim", tss: 82 },
      { id: "bike-hard", discipline: "Bike", tss: 80 },
    ],
    1,
    { swim: 0.1, bike: 0.7 }
  );
  check("a near-equal session in the limiter discipline is anchored first",
    roiAnchors[0] === "bike-hard", JSON.stringify(roiAnchors));
  check("but ROI cannot promote a trivial session over a hard one",
    selectAnchors(
      [
        { id: "easy-bike", discipline: "Bike", tss: 20 },
        { id: "hard-run", discipline: "Run", tss: 95 },
      ],
      1,
      { bike: 0.9, run: 0.05 }
    )[0] === "hard-run");

  console.log("\nAnchors protect the week's key sessions:");
  const anchorInput = [
    { id: "a", discipline: "Run", tss: 90 },
    { id: "b", discipline: "Run", tss: 40 },
    { id: "c", discipline: "Bike", tss: 80 },
    { id: "d", discipline: "Swim", tss: 30 },
    { id: "e", discipline: "Rest", tss: 0 },
  ];
  const anchors = selectAnchors(anchorInput);
  check("at most three sessions are anchored", anchors.length <= 3, String(anchors.length));
  check("the hardest run is chosen over the easy one",
    anchors.includes("a") && !anchors.includes("b"));
  check("rest days are never anchored", !anchors.includes("e"));
  check("anchoring is deterministic",
    JSON.stringify(anchors) === JSON.stringify(selectAnchors(anchorInput)));

  // ======================================================================
  console.log("\nEnd to end, on a throwaway account:");

  const email = `adapt-${Date.now()}@test.local`;
  const user = await createUser(email, "pw-test-1234");
  try {
    const noPlan = await adaptPlanForUser(user.id, { now: new Date("2026-07-30T10:00:00") });
    check("an athlete with no plan is handled, not crashed", noPlan.outcome === "no_plan");

    const start = new Date("2026-07-27T00:00:00");
    const created = await prisma.trainingPlan.create({
      data: {
        userId: user.id,
        targetRaceDate: new Date("2026-09-13T00:00:00"),
        startDate: start,
        weekCount: 7,
        currentPhase: "Base",
      },
    });

    const days = ["2026-07-31", "2026-08-01", "2026-08-02", "2026-08-03"];
    for (const [i, d] of days.entries()) {
      await prisma.plannedSession.create({
        data: {
          planId: created.id,
          week: 1,
          day: ["Friday", "Saturday", "Sunday", "Monday"][i],
          scheduledDate: new Date(d + "T00:00:00"),
          discipline: ["Bike", "Run", "Swim", "Bike"][i],
          type: "Endurance",
          duration: "60 min",
          tss: [70, 80, 40, 60][i],
          status: "planned",
          purpose: "Endurance",
        },
      });
    }

    const quiet = await adaptPlanForUser(user.id, { now: new Date("2026-07-30T10:00:00"), dryRun: true });
    check("with no completed training the plan is left alone",
      quiet.outcome === "no_change", JSON.stringify(quiet));

    // A hard session yesterday, far above what was planned.
    await prisma.plannedSession.create({
      data: {
        planId: created.id, week: 1, day: "Wednesday",
        scheduledDate: new Date("2026-07-29T00:00:00"),
        discipline: "Bike", type: "Endurance", duration: "60 min",
        tss: 60, status: "completed", purpose: "Endurance",
      },
    });
    await prisma.stravaActivity.create({
      data: {
        userId: user.id, stravaId: `test-${Date.now()}`, name: "Threshold Ride",
        sportType: "Ride", discipline: "Bike",
        startDate: new Date("2026-07-29T10:00:00"),
        movingTime: 5400, distance: 60000, estimatedTss: 150,
        isTrainer: false, detailsFetched: false,
      },
    });

    const reacted = await adaptPlanForUser(user.id, { now: new Date("2026-07-30T10:00:00"), dryRun: true });
    check("a much harder session than planned triggers the engine",
      reacted.ran === true, JSON.stringify(reacted));
    check("the engine reaches a decision it can explain",
      ["applied", "rejected_hysteresis", "no_change"].includes(reacted.outcome),
      reacted.outcome);

    // Real (non-dry) run to exercise the write path and the audit trail.
    const applied = await adaptPlanForUser(user.id, { now: new Date("2026-07-30T10:00:00") });
    const logged = await prisma.adaptation.findMany({ where: { userId: user.id } });
    check("every decision is written to the adaptation log",
      logged.length > 0, `outcome was ${applied.outcome}`);
    if (logged.length > 0) {
      check("the log records why", logged[0].cause !== null);
      check("the log records what changed", logged[0].diff !== null);
      check("the log records the scores either side",
        logged[0].scoreBefore !== null && logged[0].scoreAfter !== null);
      check("the log is reproducible from its input hash", !!logged[0].inputHash);
      check("the athlete gets an explanation", (logged[0].explanation ?? "").length > 10);
    }
    if (applied.outcome === "applied") {
      const versions = await prisma.planVersion.findMany({ where: { planId: created.id } });
      check("the previous plan is snapshotted before it changes", versions.length > 0);
    } else {
      check("a rejected change is still recorded, not silently dropped",
        logged.some((l) => l.outcome !== "applied") || applied.outcome === "no_change");
    }
    // ---- Reconciliation: the plan must reflect what actually happened ----
    console.log("\nThe plan is reconciled against what was actually done:");

    const recEmail = `recon-${Date.now()}@test.local`;
    const recUser = await createUser(recEmail, "pw-test-1234");
    try {
      const recPlan = await prisma.trainingPlan.create({
        data: {
          userId: recUser.id,
          targetRaceDate: new Date("2026-09-13T00:00:00"),
          startDate: new Date("2026-07-27T00:00:00"),
          weekCount: 7,
        },
      });

      // Mirrors the real deviation: one session done as planned, one swapped
      // for a different sport, one missed entirely, one rest day.
      const spec: Array<[string, string, string, number]> = [
        ["2026-07-27", "Monday", "Swim", 45],
        ["2026-07-28", "Tuesday", "Bike", 75],
        ["2026-07-29", "Wednesday", "Run", 50],
        ["2026-07-30", "Thursday", "Rest", 0],
      ];
      for (const [date, day, discipline, tss] of spec) {
        await prisma.plannedSession.create({
          data: {
            planId: recPlan.id, week: 1, day,
            scheduledDate: new Date(date + "T00:00:00"),
            discipline, type: discipline === "Rest" ? "Rest" : "Endurance",
            duration: "60 min", tss, status: "planned",
          },
        });
      }

      // Did the swim as planned; rode instead of running; nothing on Tuesday.
      await prisma.stravaActivity.createMany({
        data: [
          { userId: recUser.id, stravaId: `r1-${Date.now()}`, name: "Swim",
            sportType: "Swim", discipline: "Swim",
            startDate: new Date("2026-07-27T08:00:00"), movingTime: 2700,
            distance: 2000, estimatedTss: 40, isTrainer: false, detailsFetched: false },
          { userId: recUser.id, stravaId: `r2-${Date.now()}`, name: "Ride",
            sportType: "Ride", discipline: "Bike",
            startDate: new Date("2026-07-29T08:00:00"), movingTime: 4500,
            distance: 45000, estimatedTss: 95, isTrainer: false, detailsFetched: false },
        ],
      });

      const rec = await reconcilePlanWithActivities(recUser.id, {
        now: new Date("2026-07-31T09:00:00"),
      });

      check("a session done as planned is marked completed", rec.completed === 1, JSON.stringify(rec));
      check("training a different sport is recorded as substituted", rec.substituted === 1, JSON.stringify(rec));
      check("a day with no training at all is marked missed", rec.missed === 1, JSON.stringify(rec));

      const after = await prisma.plannedSession.findMany({
        where: { planId: recPlan.id }, orderBy: { scheduledDate: "asc" },
      });
      const on = (d: string, discipline?: string) =>
        after.find(
          (r) =>
            (r.scheduledDate
              ? `${r.scheduledDate.getFullYear()}-${String(r.scheduledDate.getMonth() + 1).padStart(2, "0")}-${String(r.scheduledDate.getDate()).padStart(2, "0")}`
              : "") === d &&
            !r.sourceActivityId &&
            (!discipline || r.discipline === discipline)
        )!;
      check("the completed session records what was actually done",
        on("2026-07-27").status === "completed" && on("2026-07-27").actualTss === 40,
        `${on("2026-07-27").status} / ${on("2026-07-27").actualTss}`);
      check("the missed session carries no fake load",
        on("2026-07-28").status === "missed" && on("2026-07-28").actualTss === null,
        `${on("2026-07-28").status} / ${on("2026-07-28").actualTss}`);
      // v3 §2.4 — the Baseline Rule.
      check("a substituted session keeps its planned load as the baseline",
        on("2026-07-29").status === "substituted" && on("2026-07-29").tss === 50,
        `status ${on("2026-07-29").status}, planned tss ${on("2026-07-29").tss}`);
      check("the deviation never overwrites the planned session",
        on("2026-07-29").actualTss === null,
        "the baseline is the only way to measure intent against reality");
      check("the swap is reported for the penalty engine",
        rec.swaps.some((s) => s.plannedDiscipline === "Run" && s.actualDiscipline === "Bike"),
        JSON.stringify(rec.swaps));
      const ghostActual = await prisma.plannedSession.findMany({
        where: { planId: recPlan.id, status: "unplanned" },
      });
      check("what was actually done is recorded as its own session",
        ghostActual.some((g) => g.actualTss === 95), JSON.stringify(ghostActual.map(g=>g.actualTss)));
      check("a planned rest day is never marked missed",
        on("2026-07-30", "Rest").status === "planned", on("2026-07-30", "Rest").status);

      const again = await reconcilePlanWithActivities(recUser.id, {
        now: new Date("2026-07-31T09:00:00"),
      });
      check("running it twice changes nothing further", again.changes.length === 0,
        JSON.stringify(again.changes));

      // Today is still in progress — it must not be judged.
      const todayNotJudged = await reconcilePlanWithActivities(recUser.id, {
        now: new Date("2026-07-29T09:00:00"),
      });
      check("today is never marked missed while it is still in progress",
        todayNotJudged.examined <= 2, `examined ${todayNotJudged.examined}`);

      // A deviation must now produce a real drift signal.
      const pairs = await dailyPlannedVsActual(recUser.id, {
        now: new Date("2026-07-31T09:00:00"), days: 5,
      });
      const wed = pairs.find((p) => p.date === "2026-07-29");
      check("a swapped session still yields comparable planned vs actual load",
        !!wed && wed.plannedLoad.length > 0 && wed.actualLoad.length > 0,
        JSON.stringify(wed));
      const tue = pairs.find((p) => p.date === "2026-07-28");
      check("a missed day shows planned load with nothing done",
        !!tue && tue.plannedLoad.length > 0 && tue.actualLoad.length === 0);

      // Training on a day with nothing planned must still appear in the plan.
      await prisma.stravaActivity.create({
        data: { userId: recUser.id, stravaId: `r3-${Date.now()}`, name: "Surprise Run",
          sportType: "Run", discipline: "Run",
          startDate: new Date("2026-07-30T07:00:00"), movingTime: 2400,
          distance: 7000, estimatedTss: 35, isTrainer: false, detailsFetched: false },
      });
      const withUnplanned = await reconcilePlanWithActivities(recUser.id, {
        now: new Date("2026-07-31T09:00:00"),
      });
      check("training with nothing planned is recorded as unplanned",
        withUnplanned.unplanned >= 1, JSON.stringify(withUnplanned));
      const unplannedRows = await prisma.plannedSession.findMany({
        where: { planId: recPlan.id, status: "unplanned" },
      });
      // Two: the ride done instead of the planned run, and the surprise run.
      check("unplanned training appears in the plan", unplannedRows.length === 2,
        String(unplannedRows.length));
      const surprise = unplannedRows.find((r) => r.actualTss === 35);
      check("it carries the load actually done, not prescribed load",
        surprise?.tss === 0 && surprise?.actualTss === 35,
        `tss ${surprise?.tss} actual ${surprise?.actualTss}`);
      await reconcilePlanWithActivities(recUser.id, { now: new Date("2026-07-31T09:00:00") });
      const afterTwice = await prisma.plannedSession.count({
        where: { planId: recPlan.id, status: "unplanned" },
      });
      check("re-running does not duplicate or reclassify it", afterTwice === 2, String(afterTwice));

      const manual = await prisma.plannedSession.create({
        data: {
          planId: recPlan.id, week: 1, day: "Friday",
          scheduledDate: new Date("2026-07-30T00:00:00"),
          discipline: "Run", type: "Endurance", duration: "60 min",
          tss: 40, status: "skipped",
        },
      });
      await reconcilePlanWithActivities(recUser.id, { now: new Date("2026-07-31T09:00:00") });
      const stillSkipped = await prisma.plannedSession.findUnique({ where: { id: manual.id } });
      check("a session the athlete skipped by hand is never overwritten",
        stillSkipped?.status === "skipped", stillSkipped?.status);
    } finally {
      const rp = await prisma.trainingPlan.findMany({ where: { userId: recUser.id }, select: { id: true } });
      await prisma.adaptation.deleteMany({ where: { userId: recUser.id } });
      await prisma.planVersion.deleteMany({ where: { planId: { in: rp.map((p) => p.id) } } });
      await prisma.plannedSession.deleteMany({ where: { planId: { in: rp.map((p) => p.id) } } });
      await prisma.trainingPlan.deleteMany({ where: { userId: recUser.id } });
      await prisma.stravaActivity.deleteMany({ where: { userId: recUser.id } });
      await prisma.athleteProfile.deleteMany({ where: { userId: recUser.id } });
      await prisma.user.deleteMany({ where: { id: recUser.id } });
    }

  } finally {
    await prisma.adaptation.deleteMany({ where: { userId: user.id } });
    const plans = await prisma.trainingPlan.findMany({ where: { userId: user.id }, select: { id: true } });
    await prisma.planVersion.deleteMany({ where: { planId: { in: plans.map((p) => p.id) } } });
    await prisma.plannedSession.deleteMany({ where: { planId: { in: plans.map((p) => p.id) } } });
    await prisma.trainingPlan.deleteMany({ where: { userId: user.id } });
    await prisma.stravaActivity.deleteMany({ where: { userId: user.id } });
    await prisma.athleteProfile.deleteMany({ where: { userId: user.id } });
    await prisma.user.deleteMany({ where: { id: user.id } });
    const left = await prisma.user.count({ where: { id: user.id } });
    console.log("\nCleanup:");
    check("the test account is removed", left === 0);
  }

  console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
  await prisma.$disconnect();
  if (failed > 0) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});

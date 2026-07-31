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
      check("the completed session records what was actually done",
        after[0].status === "completed" && after[0].actualTss === 40,
        `${after[0].status} / ${after[0].actualTss}`);
      check("the missed session carries no fake load",
        after[1].status === "missed" && after[1].actualTss === null,
        `${after[1].status} / ${after[1].actualTss}`);
      check("the substituted session records the load actually done",
        after[2].status === "substituted" && after[2].actualTss === 95,
        `${after[2].status} / ${after[2].actualTss}`);
      check("a planned rest day is never marked missed", after[3].status === "planned");

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

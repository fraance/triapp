/**
 * Coach chat tests: parsing, risk assessment, and re-routing.
 *
 * These are written adversarially. The engine is being handed free text and
 * then allowed to rewrite a training plan without asking, so the tests care
 * most about what it must *refuse* to do:
 *   - never invent a number the athlete did not give
 *   - never let a parsed horizon run away with months of training
 *   - never train through a red flag because the plan says so
 *   - never repay missing bike load by inflating the running
 *
 * Run with:  npm run test:coach
 */
import "./env.mts";
import { validateParsed, disciplinesLoading } from "../lib/adaptation/intent-parser";
import { assessRisk, isHighConsequenceSite } from "../lib/adaptation/risk";
import { planOpportunity } from "../lib/adaptation/opportunity";
import { hardViolations } from "../lib/adaptation/solver";
import { loadVectorFor } from "../lib/adaptation/load-vector";
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

const TODAY = "2026-08-03";

function report(over: Record<string, unknown> = {}) {
  return validateParsed(
    { fromDate: TODAY, toDate: TODAY, ...over },
    TODAY
  );
}

async function main() {
  console.log("\nTriApp — coach chat tests\n");

  // ======================================================================
  console.log("The parser never invents what was not said:");

  const blank = validateParsed({}, TODAY);
  check("an empty message yields nothing actionable", blank.empty);
  check("unstated fatigue stays null, not zero", blank.fatigue === null);
  check("unstated sleep stays null", blank.sleepQuality === null);

  const junk = validateParsed("not an object", TODAY);
  check("garbage from the model is discarded", junk.empty);

  const wild = validateParsed(
    { fatigue: 47, sleepQuality: -3, alcoholUnits: 900, stress: 2 },
    TODAY
  );
  check("out-of-range values are clamped, not trusted",
    wild.fatigue === 1 && wild.sleepQuality === 0 && wild.stress === 1,
    JSON.stringify([wild.fatigue, wild.sleepQuality, wild.stress]));
  check("an absurd alcohol figure is capped", (wild.alcoholUnits ?? 0) <= 30);

  const runaway = validateParsed(
    { unavailableDisciplines: ["bike"], fromDate: TODAY, toDate: "2027-12-31" },
    TODAY
  );
  check("a runaway horizon is clamped to weeks, not years",
    runaway.toDate <= "2026-08-24", runaway.toDate);
  check("a horizon in the past is pulled back to today",
    validateParsed({ fromDate: "2020-01-01", toDate: "2020-01-05" }, TODAY).fromDate === TODAY);

  const niggle = validateParsed(
    { niggles: [{ site: "left achilles", severity: "sore", painScale: 4 }] },
    TODAY
  );
  check("a niggle is captured with its severity",
    niggle.niggles[0].site === "left achilles" && niggle.niggles[0].severity === "sore");
  check("and mapped to the disciplines that load it",
    niggle.niggles[0].affects.includes("run"), JSON.stringify(niggle.niggles[0].affects));
  check("an impossible pain score is dropped rather than used",
    validateParsed({ niggles: [{ site: "knee", painScale: 47 }] }, TODAY)
      .niggles[0].painScale === null);
  check("a nameless niggle is discarded",
    validateParsed({ niggles: [{ severity: "sore" }] }, TODAY).niggles.length === 0);

  check("shoulder pain maps to swimming", disciplinesLoading("shoulder").includes("swim"));
  check("calf pain maps to running", disciplinesLoading("calf").includes("run"));
  check("an unknown site maps to nothing rather than everything",
    disciplinesLoading("left eyebrow").length === 0);

  check("disciplines are normalised",
    validateParsed({ unavailableDisciplines: ["cycling", "Bike"] }, TODAY)
      .unavailableDisciplines.join() === "bike");
  check("a discipline cannot be both available and unavailable",
    validateParsed(
      { unavailableDisciplines: ["bike"], availableDisciplines: ["bike", "swim"] },
      TODAY
    ).availableDisciplines.join() === "swim");

  // ======================================================================
  console.log("\nFunction A — risk is weighed against reward:");

  const fine = assessRisk({ report: report({ fatigue: 0.2 }) }, TODAY);
  check("a good day proceeds untouched", fine.decision === "proceed", fine.decision);
  check("and adds no constraints", fine.constraints.length === 0);

  const wrecked = assessRisk(
    { report: report({ fatigue: 0.9, sleepQuality: 0.1, alcoholUnits: 4 }) },
    TODAY
  );
  check("a bad night forces at least easy-only",
    ["easy_only", "rest"].includes(wrecked.decision), wrecked.decision);
  check("the athlete is told why", wrecked.reasons.length > 0);
  check("intensity is capped as a HARD constraint",
    wrecked.constraints.some((c) => c.type === "hard"));

  const painful = assessRisk(
    { report: report({ niggles: [{ site: "achilles", severity: "painful", painScale: 7 }] }) },
    TODAY
  );
  check("real pain in a tendon stops training", painful.decision === "rest", painful.decision);
  check("a high-consequence site is recognised", isHighConsequenceSite("achilles"));
  check("an ordinary ache is not treated as one", !isHighConsequenceSite("bicep"));

  const ill = assessRisk({ report: report({ illness: true }) }, TODAY);
  check("illness always means rest", ill.decision === "rest" && ill.injuryRisk === 1);

  const mildNiggle = assessRisk(
    { report: report({ niggles: [{ site: "calf", severity: "sore", painScale: 3 }] }) },
    TODAY
  );
  check("a sore calf does not stop everything",
    mildNiggle.decision !== "rest", mildNiggle.decision);
  check("but it does hold running load down",
    mildNiggle.constraints.some(
      (c) => c.type === "hard" && c.reason.toLowerCase().includes("calf")),
    JSON.stringify(mildNiggle.constraints.map((c) => c.reason)));

  const shoulder = assessRisk(
    { report: report({ niggles: [{ site: "shoulder", severity: "painful", painScale: 6 }] }) },
    TODAY
  );
  check("a shoulder problem constrains the upper body, not the legs",
    shoulder.constraints.some((c) => c.component === "upper"),
    JSON.stringify(shoulder.constraints.map((c) => c.component)));

  const overreached = assessRisk({ report: report({ fatigue: 0.5 }), acwr: 1.6 }, TODAY);
  check("a dangerous acute:chronic ratio raises the risk on its own",
    overreached.injuryRisk > assessRisk({ report: report({ fatigue: 0.5 }) }, TODAY).injuryRisk);

  const empty = assessRisk({ report: report({ fatigue: 0.4 }), glycogen: 0.2 }, TODAY);
  check("empty fuel stores lower what a session is worth",
    empty.fitnessGain < 0.8, String(empty.fitnessGain));

  const nearRace = assessRisk(
    { report: report({ fatigue: 0.65 }), daysToRace: 5 },
    TODAY
  );
  check("close to the race the engine will not wave fatigue through",
    nearRace.decision !== "proceed", nearRace.decision);
  check("the same fatigue far from the race is treated less severely",
    assessRisk({ report: report({ fatigue: 0.65 }), daysToRace: 120 }, TODAY)
      .decision === "proceed",
    "loss aversion should scale with how little there is left to gain");

  // ======================================================================
  console.log("\nFunction B — a constraint becomes an opportunity:");

  const noBike = planOpportunity({
    report: report({
      unavailableDisciplines: ["bike"],
      fromDate: TODAY,
      toDate: "2026-08-06",
    }),
    plannedByDiscipline: { bike: 200, run: 60, swim: 40 },
    limiterPriority: { run: 0.5, swim: 0.2, bike: 0.3 },
    mechanicalHeadroom: 15,
  });
  check("the missing discipline is blocked outright",
    noBike.constraints.some((c) => c.type === "hard" && c.disciplines?.includes("bike")));
  check("the window is given a focus rather than emptied",
    noBike.focus !== null, String(noBike.focus));
  check("the athlete is told what the days become",
    noBike.rationale.join(" ").includes("block"), JSON.stringify(noBike.rationale));

  check("missing bike load is NOT poured into running",
    noBike.redirectedLoad <= 15,
    `redirected ${noBike.redirectedLoad} of 200 lost — the mechanical ramp is the ceiling`);
  check("what cannot be absorbed is deferred, not crammed in",
    noBike.deferredLoad > 100, String(noBike.deferredLoad));
  check("and the athlete is told it will not be repaid on the long sessions",
    noBike.rationale.join(" ").includes("long"), JSON.stringify(noBike.rationale));

  const beach = planOpportunity({
    report: report({
      unavailableDisciplines: ["bike", "run"],
      availableDisciplines: ["swim"],
      fromDate: TODAY,
      toDate: "2026-08-05",
    }),
    plannedByDiscipline: { bike: 150, run: 80 },
    limiterPriority: { swim: 0.2, bike: 0.5, run: 0.3 },
  });
  check("with only swimming available, swimming is the focus",
    beach.focus === "swim", String(beach.focus));
  check("swimming absorbs more than running would",
    beach.redirectedLoad > noBike.redirectedLoad,
    `${beach.redirectedLoad} vs ${noBike.redirectedLoad}`);
  check("both blocked disciplines are constrained",
    beach.constraints.filter((c) => c.kind === "availability").length === 2);

  const nothing = planOpportunity({
    report: report({
      unavailableDisciplines: ["swim", "bike", "run", "strength"],
      fromDate: TODAY,
      toDate: "2026-08-05",
    }),
    plannedByDiscipline: { bike: 100 },
  });
  check("a total blackout becomes recovery, not a scramble",
    nothing.focus === "recovery", String(nothing.focus));

  const unconstrained = planOpportunity({
    report: report({ fatigue: 0.3 }),
    plannedByDiscipline: { bike: 100 },
  });
  check("no logistical constraint means no re-routing",
    unconstrained.constraints.length === 0 && unconstrained.focus === null);

  const noKit = planOpportunity({
    report: report({ missingEquipment: ["bike"], fromDate: TODAY, toDate: "2026-08-05" }),
    plannedByDiscipline: { bike: 100 },
  });
  check("missing kit blocks the discipline it belongs to",
    noKit.blocked.includes("bike"), JSON.stringify(noKit.blocked));

  // ======================================================================
  console.log("\nThe solver actually enforces the blackout:");

  const session = (id: string, date: string, discipline: string) => ({
    id, date, discipline, type: "Endurance", durationMinutes: 60, tss: 60,
    load: loadVectorFor({ discipline, tss: 60, type: "Endurance" }),
    purpose: "Endurance", isAnchor: false, status: "planned",
  });

  const blocked = [
    { kind: "availability" as const, type: "hard" as const, source: "logistics",
      reason: "no bike", fromDate: TODAY, toDate: "2026-08-06", disciplines: ["bike"] },
  ];
  const violations = hardViolations(
    [session("a", "2026-08-04", "Bike")],
    { today: TODAY, sessions: [], constraints: blocked, preferences: [],
      chronicLoad: { metabolic: 0, mechanical: 0, neuromuscular: 0, upper: 0 } } as never
  );
  check("a bike session inside the blackout is a hard violation",
    violations.length > 0, JSON.stringify(violations));
  check("a swim in the same window is fine",
    hardViolations(
      [session("b", "2026-08-04", "Swim")],
      { today: TODAY, sessions: [], constraints: blocked, preferences: [],
        chronicLoad: { metabolic: 0, mechanical: 0, neuromuscular: 0, upper: 0 } } as never
    ).length === 0);
  check("a bike session after the window is fine",
    hardViolations(
      [session("c", "2026-08-09", "Bike")],
      { today: TODAY, sessions: [], constraints: blocked, preferences: [],
        chronicLoad: { metabolic: 0, mechanical: 0, neuromuscular: 0, upper: 0 } } as never
    ).length === 0);

  console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
  await prisma.$disconnect();
  if (failed > 0) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});

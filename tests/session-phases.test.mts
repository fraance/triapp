/**
 * The session viewer should read as a coached workout, not one dense paragraph.
 * These tests lock down how free-text instructions split into numbered
 * warm-up / core / cool-down cards.
 *
 * Run with:  npm run test:phases
 */
import { segmentPhases } from "../lib/session-phases";

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

function labels(p: ReturnType<typeof segmentPhases>) {
  return p.map((x) => x.label).join(" | ");
}

function main() {
  console.log("\nTriApp — session phase segmentation tests\n");

  const standard =
    "Warm-up 10 min easy (Zone 1). Main: 6x3 min at threshold pace (Zone 4, 5:30/km) with 2 min easy jog in between. Cool-down 10 min easy.";
  const p = segmentPhases(standard);
  check("three chronological phases", labels(p) === "Warm-up | Core | Cool-down", labels(p));
  check("steps numbered 1..3", p.map((x) => x.step).join("") === "123");
  check("warm-up marker stripped", p[0].body === "10 min easy (Zone 1).", p[0].body);
  check("core marker stripped", p[1].body.startsWith("6x3 min"), p[1].body);
  check("cool-down body kept", p[2].body === "10 min easy.", p[2].body);

  const marked = segmentPhases(
    "Warm-up 400m easy. Main set: 90 min at moderate effort (Zone 2). Cool-down 300m."
  );
  check("'main set' also recognised and stripped",
    labels(marked) === "Warm-up | Core | Cool-down" && marked[1].body === "90 min at moderate effort (Zone 2).",
    marked[1]?.body);

  const noWarm = segmentPhases(
    "Easy swim focusing on form, no sets. Just drill and technique work."
  );
  check("unstructured text degrades to a single core card",
    labels(noWarm) === "Core" && noWarm[0].body.includes("Easy swim"),
    labels(noWarm));

  check("empty string yields nothing", segmentPhases("").length === 0);

  // Warm-up that runs straight into a 'Main set' on the same line keeps the
  // core opener instead of swallowing it into the warm-up card.
  const glued = segmentPhases("Warm up 15 min easy. Main set: 3x8 min. Cool down 5 min.");
  check("short warm-up does not swallow the main set",
    labels(glued) === "Warm-up | Core | Cool-down" && glued[1].body === "3x8 min.",
    glued.map((x) => x.body).join(" // "));

  console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
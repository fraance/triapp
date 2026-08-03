/**
 * Tests for what the athlete is actually shown.
 *
 * Every case here came from the athlete reporting it: a race date that
 * "wouldn't stick", sessions marked done that they knew they had not done,
 * past sessions cluttering the week view.
 *
 * Run with:  npm run test:ui
 */
import "./env.mts";
import { toDateInput } from "../lib/date-input";
import { hidePastNonEvents, hideGhosts } from "../lib/session-status";

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

console.log("\nTriApp — what the athlete sees\n");

console.log("A saved date shows up in the field again:");

check("an ISO timestamp becomes a date the input accepts",
  toDateInput("2026-09-12T00:00:00.000Z") === "2026-09-12",
  toDateInput("2026-09-12T00:00:00.000Z"));
check("this is the whole bug: the raw value renders blank",
  !/^\d{4}-\d{2}-\d{2}$/.test("2026-09-12T00:00:00.000Z"),
  "an input type=date silently shows nothing unless the value is yyyy-MM-dd");
check("an already-correct value is untouched",
  toDateInput("2026-09-12") === "2026-09-12");
check("a Date object works", toDateInput(new Date(2026, 8, 12)) === "2026-09-12");
check("null and empty give an empty field",
  toDateInput(null) === "" && toDateInput(undefined) === "" && toDateInput("") === "");
check("nonsense gives an empty field rather than a wrong date",
  toDateInput("not a date") === "" && toDateInput({}) === "");
check("a UTC midnight does not slip back a day",
  toDateInput("2026-01-01T00:00:00.000Z") === "2026-01-01",
  "reparsing through a positive offset would give 2025-12-31");

console.log("\nA past day shows what happened, not what was intended:");

const week = [
  { id: "a", status: "completed", date: "2026-08-01" },
  { id: "b", status: "skipped", date: "2026-08-01" },
  { id: "c", status: "missed", date: "2026-08-02" },
  { id: "d", status: "planned", date: "2026-08-02" },
  { id: "e", status: "planned", date: "2026-08-05" },
  { id: "f", status: "unplanned", date: "2026-08-03" },
];
const shown = hidePastNonEvents(week, "2026-08-04");

check("a session you completed is still shown",
  shown.some((s) => s.id === "a"));
check("training you did with nothing planned is shown",
  shown.some((s) => s.id === "f"));
check("a discarded session is not shown", !shown.some((s) => s.id === "b"),
  "it stays in the database, it just is not the athlete's history");
check("a missed session is not shown", !shown.some((s) => s.id === "c"));
check("a past day that simply went by is not shown",
  !shown.some((s) => s.id === "d"));
check("future sessions are all still shown", shown.some((s) => s.id === "e"));

const todayItems = hidePastNonEvents(
  [{ id: "t", status: "planned", date: "2026-08-04" }],
  "2026-08-04"
);
check("today is not treated as the past", todayItems.length === 1,
  "today is still in play, and the athlete can still act on it");

console.log("\nGhosts and past-events rules compose:");
const both = hidePastNonEvents(
  hideGhosts([
    { id: "g", status: "substituted", date: "2026-08-01" },
    { id: "h", status: "unplanned", date: "2026-08-01" },
  ]),
  "2026-08-04"
);
check("a substitution shows only what was actually done",
  both.length === 1 && both[0].id === "h", JSON.stringify(both.map((s) => s.id)));

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);

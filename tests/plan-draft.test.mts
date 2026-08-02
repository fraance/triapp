/**
 * Tests for the calendar's draft state and linear undo history.
 *
 * Pure functions, no database and no browser — so this suite touches no user
 * data at all.
 *
 * What must hold:
 *   1. Undo and Redo step backward and forward without destroying anything.
 *   2. A new edit after stepping back discards the redo future.
 *   3. Saving sends the net difference from baseline, not a replay of drags.
 *      Dragging a session out and back saves nothing.
 *   4. Reset-week is one undoable step, and covers sessions dragged out of the
 *      week as well as into it.
 *   5. A move that changes nothing never costs an Undo.
 *
 * Run with:  npm run test:draft
 */
import {
  emptyDraft,
  pushStep,
  positions,
  dateOf,
  undo,
  redo,
  canUndo,
  canRedo,
  undoLabel,
  redoLabel,
  netMoves,
  isDirty,
  discardAll,
  resetWeekStep,
  weekIsDirty,
  DraftState,
} from "../lib/plan-draft";

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

/** Week 1 = 3-9 Aug 2026, week 2 = 10-16 Aug, etc. */
const weekOf = (date: string): number => {
  const start = Date.UTC(2026, 7, 3);
  const [y, m, d] = date.split("-").map(Number);
  const days = Math.floor((Date.UTC(y, m - 1, d) - start) / 86_400_000);
  return Math.floor(days / 7) + 1;
};

/** swim Mon w1, run Wed w1, bike Sat w1, longRun Tue w2 */
const BASELINE = {
  swim: "2026-08-03",
  run: "2026-08-05",
  bike: "2026-08-08",
  longRun: "2026-08-11",
};

const move = (id: string, from: string, to: string, label = `Moved ${id}`) => ({
  label,
  moves: [{ sessionId: id, from, to }],
});

console.log("\nTriApp — calendar draft state tests\n");

console.log("A fresh draft is the baseline:");
let s: DraftState = emptyDraft(BASELINE);
check("nothing to undo", !canUndo(s));
check("nothing to redo", !canRedo(s));
check("nothing to save", !isDirty(s));
check("positions match the baseline", dateOf(s, "run") === "2026-08-05");

console.log("\nMoving a session:");
s = pushStep(s, move("run", "2026-08-05", "2026-08-07"));
check("the session is in its new place", dateOf(s, "run") === "2026-08-07");
check("the draft is dirty", isDirty(s));
check("there is one move to save", netMoves(s).length === 1);
check(
  "and it names the destination",
  netMoves(s)[0].toDate === "2026-08-07"
);
check("other sessions are untouched", dateOf(s, "swim") === "2026-08-03");

console.log("\nStepping back through three moves:");
s = pushStep(s, move("swim", "2026-08-03", "2026-08-04"));
s = pushStep(s, move("bike", "2026-08-08", "2026-08-09"));
check("three steps recorded", s.steps.length === 3);
check("all three are applied", netMoves(s).length === 3);

s = undo(s);
check("one undo takes back the last move", dateOf(s, "bike") === "2026-08-08");
check("but keeps the earlier two", netMoves(s).length === 2);

s = undo(s);
check("two undos take back the second", dateOf(s, "swim") === "2026-08-03");
check("leaving one", netMoves(s).length === 1);

s = undo(s);
check("three undos reach the baseline", !isDirty(s));
check("and there is nothing left to undo", !canUndo(s));
check("undo cannot go past the baseline", undo(s).cursor === 0);

console.log("\nRedo steps forward again:");
check("there are three futures to redo", canRedo(s));
s = redo(s);
check("redo reapplies the first move", dateOf(s, "run") === "2026-08-07");
s = redo(s);
s = redo(s);
check("redo reaches the latest state", netMoves(s).length === 3);
check("and stops there", !canRedo(s));
check("redo cannot overshoot", redo(s).cursor === 3);

console.log("\nThe labels say what will happen:");
check("undo names the last action", undoLabel(s) === "Moved bike");
s = undo(s);
check("redo names the action ahead", redoLabel(s) === "Moved bike");
check("and undo now names the one before", undoLabel(s) === "Moved swim");
s = redo(s);

console.log("\nA new edit discards the redo future:");
let branched = undo(undo(s)); // back to just the run move
check("stepped back two", netMoves(branched).length === 1);
branched = pushStep(branched, move("longRun", "2026-08-11", "2026-08-12"));
check("the new edit is applied", dateOf(branched, "longRun") === "2026-08-12");
check("the discarded future is gone", !canRedo(branched));
check("history is two steps long", branched.steps.length === 2);
check(
  "and the abandoned moves are not saved",
  netMoves(branched).map((m) => m.sessionId).join() === "longRun,run"
);

console.log("\nSaving sends the net change, not a replay:");
let roundTrip = emptyDraft(BASELINE);
roundTrip = pushStep(roundTrip, move("run", "2026-08-05", "2026-08-07"));
roundTrip = pushStep(roundTrip, move("run", "2026-08-07", "2026-08-09"));
roundTrip = pushStep(roundTrip, move("run", "2026-08-09", "2026-08-05"));
check("three drags of one session...", roundTrip.steps.length === 3);
check("...that end where they started save nothing", netMoves(roundTrip).length === 0);
check("and the draft is clean", !isDirty(roundTrip));

let twice = emptyDraft(BASELINE);
twice = pushStep(twice, move("run", "2026-08-05", "2026-08-06"));
twice = pushStep(twice, move("run", "2026-08-06", "2026-08-07"));
check("a session dragged twice saves once", netMoves(twice).length === 1);
check("with its final destination", netMoves(twice)[0].toDate === "2026-08-07");

console.log("\nA move that changes nothing is not an edit:");
const noop = pushStep(emptyDraft(BASELINE), move("run", "2026-08-05", "2026-08-05"));
check("no step is recorded", noop.steps.length === 0);
check("and there is nothing to undo", !canUndo(noop));

console.log("\nReset returns one week to baseline:");
let multi = emptyDraft(BASELINE);
multi = pushStep(multi, move("run", "2026-08-05", "2026-08-07")); // within w1
multi = pushStep(multi, move("swim", "2026-08-03", "2026-08-04")); // within w1
multi = pushStep(multi, move("longRun", "2026-08-11", "2026-08-13")); // within w2
check("three weeks-worth of edits", netMoves(multi).length === 3);
check("week 1 is dirty", weekIsDirty(multi, 1, weekOf));
check("week 2 is dirty", weekIsDirty(multi, 2, weekOf));
check("week 3 is untouched", !weekIsDirty(multi, 3, weekOf));

const reset1 = resetWeekStep(multi, 1, weekOf);
check("resetting week 1 covers both of its moves", reset1.moves.length === 2);
multi = pushStep(multi, reset1);
check("week 1 is back to baseline", dateOf(multi, "run") === "2026-08-05");
check("and so is the swim", dateOf(multi, "swim") === "2026-08-03");
check("week 2 is left alone", dateOf(multi, "longRun") === "2026-08-13");
check("only week 2's change remains to save", netMoves(multi).length === 1);
check("week 1 is no longer dirty", !weekIsDirty(multi, 1, weekOf));

console.log("\nReset is a single undoable step:");
multi = undo(multi);
check("one undo brings the whole week back", netMoves(multi).length === 3);
check("including the run", dateOf(multi, "run") === "2026-08-07");
check("and the swim", dateOf(multi, "swim") === "2026-08-04");

console.log("\nReset covers sessions dragged OUT of the week:");
let across = emptyDraft(BASELINE);
// Drag a week-1 session into week 2.
across = pushStep(across, move("bike", "2026-08-08", "2026-08-12"));
check("the session now sits in week 2", weekOf(dateOf(across, "bike")) === 2);
check(
  "week 1 still counts it as its own change",
  weekIsDirty(across, 1, weekOf)
);
check(
  "and so does week 2, where it landed",
  weekIsDirty(across, 2, weekOf)
);
across = pushStep(across, resetWeekStep(across, 1, weekOf));
check("resetting week 1 brings it home", dateOf(across, "bike") === "2026-08-08");

console.log("\nDiscarding everything:");
let all = emptyDraft(BASELINE);
all = pushStep(all, move("run", "2026-08-05", "2026-08-07"));
all = pushStep(all, move("swim", "2026-08-03", "2026-08-04"));
const discarded = discardAll(all);
check("nothing is left to save", !isDirty(discarded));
check("but it can still be redone", canRedo(discarded));

console.log("\nPositions never mutate the baseline:");
const guard = pushStep(emptyDraft(BASELINE), move("run", "2026-08-05", "2026-08-07"));
positions(guard);
check("the baseline is intact", guard.baseline.run === "2026-08-05");
check("and the original object is unchanged", BASELINE.run === "2026-08-05");

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);

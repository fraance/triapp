/**
 * The calendar's draft state — what the athlete has rearranged but not saved.
 *
 * Kept deliberately separate from React so the rules can be tested without a
 * browser. The component owns the pointer events; this owns the meaning.
 *
 * The model is a linear history:
 *
 *   baseline (State 0)  ->  step 1  ->  step 2  ->  step 3
 *                                          ^
 *                                        cursor
 *
 * `baseline` is the plan as the database last confirmed it. Every edit pushes
 * a step. `cursor` says how many steps are currently applied, so Undo is
 * cursor-1 and Redo is cursor+1 — no state is destroyed by stepping back.
 * Making a new edit while stepped back discards the steps ahead, which is what
 * every editor does and what people expect.
 *
 * A step can carry several moves. That is what makes "Reset this week" fit the
 * same history: it is one step that happens to move five sessions, so a single
 * Undo takes it back. Without that, Reset would be the one action you couldn't
 * undo.
 *
 * Nothing here talks to the database. Saving sends `netMoves()`, which is the
 * difference between baseline and now — not a replay of every drag. Dragging a
 * session out and back should save nothing at all.
 */

/** One session changing day. */
export interface DraftMove {
  sessionId: string;
  from: string;
  to: string;
}

/** One undoable action, which may move several sessions at once. */
export interface DraftStep {
  /** Shown in the undo tooltip, e.g. "Moved Run to Friday". */
  label: string;
  moves: DraftMove[];
}

export interface DraftState {
  /** Where every session sat when the calendar was opened. */
  baseline: Record<string, string>;
  steps: DraftStep[];
  /** How many steps are applied. 0 = baseline. */
  cursor: number;
}

export function emptyDraft(baseline: Record<string, string>): DraftState {
  return { baseline, steps: [], cursor: 0 };
}

/** Where each session sits right now, after applying the active steps. */
export function positions(state: DraftState): Record<string, string> {
  const out = { ...state.baseline };
  for (const step of state.steps.slice(0, state.cursor)) {
    for (const move of step.moves) out[move.sessionId] = move.to;
  }
  return out;
}

/** The current day for one session. */
export function dateOf(state: DraftState, sessionId: string): string {
  return positions(state)[sessionId] ?? state.baseline[sessionId];
}

/**
 * Records a new edit. Anything the athlete had stepped forward past is
 * discarded, because the history is linear — you cannot redo into a future
 * that no longer follows from the present.
 */
export function pushStep(state: DraftState, step: DraftStep): DraftState {
  // A move that changes nothing is not an edit, and shouldn't cost an Undo.
  const real = step.moves.filter((m) => m.from !== m.to);
  if (real.length === 0) return state;

  const steps = [...state.steps.slice(0, state.cursor), { ...step, moves: real }];
  return { ...state, steps, cursor: steps.length };
}

export function canUndo(state: DraftState): boolean {
  return state.cursor > 0;
}

export function canRedo(state: DraftState): boolean {
  return state.cursor < state.steps.length;
}

export function undo(state: DraftState): DraftState {
  return canUndo(state) ? { ...state, cursor: state.cursor - 1 } : state;
}

export function redo(state: DraftState): DraftState {
  return canRedo(state) ? { ...state, cursor: state.cursor + 1 } : state;
}

/** Back to State 0, keeping the steps so it is itself undoable. */
export function discardAll(state: DraftState): DraftState {
  return { ...state, cursor: 0 };
}

/** What Undo is about to take back, for the button's tooltip. */
export function undoLabel(state: DraftState): string | null {
  return canUndo(state) ? state.steps[state.cursor - 1].label : null;
}

export function redoLabel(state: DraftState): string | null {
  return canRedo(state) ? state.steps[state.cursor].label : null;
}

/**
 * The moves to send to the server: every session that is somewhere other than
 * where it started. Order and intermediate positions don't matter — only the
 * destination does — so a session dragged across three days saves once.
 */
export function netMoves(
  state: DraftState
): { sessionId: string; toDate: string }[] {
  const now = positions(state);
  const moves: { sessionId: string; toDate: string }[] = [];
  for (const [sessionId, date] of Object.entries(now)) {
    if (state.baseline[sessionId] !== date) moves.push({ sessionId, toDate: date });
  }
  return moves.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}

/** Is there anything worth saving? */
export function isDirty(state: DraftState): boolean {
  return netMoves(state).length > 0;
}

/**
 * A step that returns one week to baseline.
 *
 * "This week" means anything that either started in the week or has been
 * dragged into it — otherwise resetting a week couldn't undo a session you had
 * dragged out of it, which is exactly the mistake people want to take back.
 *
 * `weekOf` maps a date to a week number; the caller supplies it because the
 * plan's start date lives on the server.
 */
export function resetWeekStep(
  state: DraftState,
  week: number,
  weekOf: (date: string) => number
): DraftStep {
  const now = positions(state);
  const moves: DraftMove[] = [];

  for (const [sessionId, current] of Object.entries(now)) {
    const original = state.baseline[sessionId];
    if (current === original) continue;
    if (weekOf(current) !== week && weekOf(original) !== week) continue;
    moves.push({ sessionId, from: current, to: original });
  }

  return { label: `Reset week ${week}`, moves };
}

/** Whether a given week has unsaved changes, for showing its Reset button. */
export function weekIsDirty(
  state: DraftState,
  week: number,
  weekOf: (date: string) => number
): boolean {
  return resetWeekStep(state, week, weekOf).moves.length > 0;
}

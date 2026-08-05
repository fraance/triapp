/**
 * What a session's status actually means.
 *
 * These strings were being interpreted independently in `getTodayView`,
 * `getSeasonView` and the calendar component, and the three had drifted. The
 * calendar treated "anything that isn't planned" as history, so a **missed**
 * session rendered green and counted towards completed load — the plan
 * congratulating the athlete for training they did not do.
 *
 * One definition, used everywhere. Pure and dependency-free so both the server
 * and the browser can import it.
 *
 * The statuses, and where they come from:
 *
 *   planned      nothing has happened yet
 *   adapted      the engine moved or reshaped it; still upcoming
 *   completed    reconciled against a Strava activity of the same discipline
 *   substituted  they trained that day, but a different discipline
 *   missed       the day passed with no training at all
 *   skipped      the athlete said so themselves
 *   unplanned    a Strava activity with nothing planned for that day
 */

/** Still ahead of the athlete: a plan, not a record. */
export const UPCOMING_STATUSES = ["planned", "adapted"] as const;

/**
 * Training that genuinely happened, evidenced by a Strava activity.
 *
 * `substituted` is deliberately NOT here. Under the Baseline Rule (v3 §2.4)
 * a substituted session is a *ghost*: it keeps the prescribed load as the
 * intent baseline, and its `actualTss` is null because the work the athlete
 * actually did is recorded on its own `unplanned` row. Counting the ghost as
 * training too would count the day twice — and, since the ghost's actualTss is
 * null, would fall back to the planned figure and credit them for a session
 * they did not do.
 */
export const TRAINED_STATUSES = ["completed", "unplanned"] as const;

/**
 * Statuses that are a record of the past, whether or not training happened.
 * `missed` and `skipped` belong here: they are settled, but they are NOT
 * achievements and must never be counted or coloured as such.
 */
export const SETTLED_STATUSES = [
  ...TRAINED_STATUSES,
  "substituted",
  "missed",
  "skipped",
] as const;

export function isUpcoming(status: string): boolean {
  return (UPCOMING_STATUSES as readonly string[]).includes(status);
}

/** Did the athlete actually train? The only thing that may count as done. */
export function didTrain(status: string): boolean {
  return (TRAINED_STATUSES as readonly string[]).includes(status);
}

export function isSettled(status: string): boolean {
  return (SETTLED_STATUSES as readonly string[]).includes(status);
}

/**
 * A "ghost": the planned session kept as the intent-vs-reality baseline after
 * the day went differently (v3 §2.4). The database must retain it — it is the
 * only record of what was meant to happen — but the athlete should not be
 * shown a session they did not do sitting next to the one they did.
 */
export function isGhost(status: string): boolean {
  return status === "substituted" || status === "missed";
}

/**
 * The load to display for a session.
 *
 * Training that happened is worth what it actually cost, not what was
 * prescribed. This is why unplanned sessions were showing 0: reconciliation
 * writes `tss: 0` on them deliberately, because nothing was prescribed, and
 * puts the real figure in `actualTss`. Reading `tss` alone reports a session
 * the athlete definitely did as costing nothing.
 */
export function displayTss(session: {
  tss: number;
  actualTss?: number | null;
  status: string;
}): number {
  if (didTrain(session.status)) return session.actualTss ?? session.tss;
  return session.tss;
}

/**
 * Load that counts as completed. Only training that actually happened, and
 * only what it actually cost.
 */
export function completedTss(session: {
  tss: number;
  actualTss?: number | null;
  status: string;
}): number {
  return didTrain(session.status) ? (session.actualTss ?? session.tss) : 0;
}

/**
 * Hides ghost sessions on days the athlete did train, per v3 §2.4: "in the UI,
 * hide the missed session and only show the completed one."
 *
 * A ghost on a day with no training at all is deliberately kept visible — the
 * athlete needs to know they missed something. Hiding that would be the app
 * quietly editing their history.
 */
export function hideGhosts<T extends { status: string; date: string }>(
  sessions: T[]
): T[] {
  const trainedOn = new Set(
    sessions.filter((s) => didTrain(s.status)).map((s) => s.date)
  );
  return sessions.filter((s) => !(isGhost(s.status) && trainedOn.has(s.date)));
}

/**
 * What the athlete should see for a day that has already passed.
 *
 * A past day is a record, not a plan. Sessions that were *deliberately* set
 * aside — skipped, or still sitting at "planned" because the day simply went
 * by — are noise in a calendar the athlete reads to see what they *did*. They
 * remain in the database as the intent baseline; they are only hidden from
 * view.
 *
 * A `missed` session is different: the day came and went with no training and
 * nothing on record to say it was intentional. Hiding it would be the app
 * quietly editing the athlete's history (v3 §2.4) — the same reason
 * `hideGhosts` keeps a missed ghost on a day with no other activity. So a
 * missed past day stays visible.
 *
 * Today is deliberately not treated as past: it is still in play.
 */
export function hidePastNonEvents<T extends { status: string; date: string }>(
  sessions: T[],
  today: string
): T[] {
  return sessions.filter((s) => {
    if (s.date >= today) return true;
    if (didTrain(s.status)) return true;
    // `missed` is a settled, non-achieving record the athlete must still see.
    if (s.status === "missed") return true;
    // A past skipped/planned day: nothing actually happened, don't show it.
    return false;
  });
}

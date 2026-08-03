/**
 * Function B — Dynamic re-routing (offence).
 *
 * A logistical constraint is not a cancellation. Four days without a bike is
 * four days to build something else, and the bike work moves rather than
 * evaporates.
 *
 * The trap this module exists to avoid: taking the load from the missing
 * discipline and pouring it into the ones that remain. LOGIC_V2 §0.2 calls
 * that "the single most dangerous rule in V1" — 90 TSS of cycling redirected
 * into running is not equivalent work, it is a large increase in eccentric
 * load on tissue that has not been prepared for it. So:
 *
 *   - Substituted volume is capped by the **mechanical** ramp, not by the TSS
 *     that went missing.
 *   - Swimming absorbs redirected load most freely, cycling next, running
 *     least — in exact proportion to how much damage each does.
 *   - Whatever cannot be safely absorbed is simply forgiven, or moved to the
 *     week after the constraint ends if the calendar allows.
 *
 * Pure functions. Constraints and preferences out; the solver decides.
 */
import { Constraint, LoadVector, Preference } from "./types";
import { ParsedReport } from "./intent-parser";
import { localISO } from "./load-vector";

/** How much redirected load each discipline may safely absorb. */
const ABSORPTION: Record<string, number> = {
  swim: 0.8, // near-zero mechanical cost
  bike: 0.5,
  strength: 0.3,
  run: 0.2, // eccentric damage — the least able to take extra
};

export interface OpportunityInput {
  report: ParsedReport;
  /** Load already planned in the constrained window, by discipline. */
  plannedByDiscipline: Record<string, number>;
  /** Race-course ROI per discipline (v3 §3.1), so focus follows value. */
  limiterPriority?: Record<string, number>;
  /** Mechanical load headroom this week, from the guardrails. */
  mechanicalHeadroom?: number | null;
}

export interface OpportunityPlan {
  /** Disciplines blocked for the window. */
  blocked: string[];
  /** What the window becomes: the focus the engine chose. */
  focus: string | null;
  /** Load that could not be safely absorbed and is deferred or forgiven. */
  deferredLoad: number;
  /** Load redirected into what remains. */
  redirectedLoad: number;
  constraints: Constraint[];
  preferences: Preference[];
  /** Plain-English rationale, used by the narrator. */
  rationale: string[];
  facts: Record<string, unknown>;
}

const ALL = ["swim", "bike", "run", "strength"];

/**
 * Works out what a constrained window should become.
 */
export function planOpportunity(input: OpportunityInput): OpportunityPlan {
  const { report } = input;
  const rationale: string[] = [];
  const constraints: Constraint[] = [];
  const preferences: Preference[] = [];

  const blocked = [...report.unavailableDisciplines];
  // Missing kit blocks the discipline it belongs to.
  for (const item of report.missingEquipment) {
    if (/bike|bicycle|turbo|trainer/.test(item) && !blocked.includes("bike")) {
      blocked.push("bike");
    }
    if (/pool|goggles|wetsuit/.test(item) && !blocked.includes("swim")) {
      // A missing wetsuit does not block swimming outright — only cold water.
      if (/pool/.test(item)) blocked.push("swim");
    }
  }

  if (blocked.length === 0) {
    return {
      blocked: [],
      focus: null,
      deferredLoad: 0,
      redirectedLoad: 0,
      constraints: [],
      preferences: [],
      rationale: [],
      facts: { blocked: [] },
    };
  }

  const from = report.fromDate;
  const to = report.toDate;
  const days =
    Math.round(
      (new Date(to + "T00:00:00").getTime() - new Date(from + "T00:00:00").getTime()) /
        86400000
    ) + 1;

  // Block the unavailable disciplines outright.
  for (const d of blocked) {
    constraints.push({
      kind: "availability",
      type: "hard",
      source: "logistics",
      reason: `You have no ${d} available from ${from} to ${to}.`,
      fromDate: from,
      toDate: to,
      disciplines: [d],
    });
  }

  // What is actually left to train?
  const stated = report.availableDisciplines;
  const remaining = (stated.length > 0 ? stated : ALL).filter(
    (d) => !blocked.includes(d)
  );

  const lostLoad = blocked.reduce(
    (n, d) => n + (input.plannedByDiscipline[d] ?? 0),
    0
  );

  if (remaining.length === 0) {
    rationale.push(
      `Nothing is available between ${from} and ${to}, so the block becomes ` +
        `recovery and the work moves to the other side of it.`
    );
    return {
      blocked,
      focus: "recovery",
      deferredLoad: lostLoad,
      redirectedLoad: 0,
      constraints,
      preferences,
      rationale,
      facts: { blocked, days, lostLoad, focus: "recovery" },
    };
  }

  // ---- Choose the focus -------------------------------------------------
  // Where the athlete has most to gain, among what they can actually do.
  const priority = input.limiterPriority ?? {};
  // A discipline absent from the ROI analysis (strength, say) scores 0 rather
  // than a neutral default: defaulting to 0.33 let it outrank a swim that the
  // analysis had actually measured as low-value, and made strength the focus
  // of a four-day block for no reason.
  const hasPriorities = Object.keys(priority).length > 0;
  const roiOf = (d: string) => priority[d] ?? (hasPriorities ? 0 : 0.33);
  const focus = [...remaining].sort(
    (a, b) => roiOf(b) - roiOf(a) || a.localeCompare(b)
  )[0];

  // ---- How much may safely move ------------------------------------------
  const absorption = ABSORPTION[focus] ?? 0.3;
  let capacity = lostLoad * absorption;

  // The mechanical ramp is the real ceiling when running is the fallback.
  if (focus === "run" && input.mechanicalHeadroom != null) {
    const before = capacity;
    capacity = Math.min(capacity, Math.max(0, input.mechanicalHeadroom));
    if (capacity < before) {
      rationale.push(
        `Only part of the missing load moves into running: impact load can only ` +
          `rise so fast, and that limit is what keeps you off the injury list.`
      );
    }
  }

  const redirected = Math.round(capacity);
  const deferred = Math.max(0, Math.round(lostLoad - redirected));

  // ---- Express it as guidance for the solver -----------------------------
  const focusNoun =
    focus === "swim"
      ? days >= 3
        ? "swim technique block"
        : "swim focus"
      : focus === "run"
        ? days >= 3
          ? "run volume block"
          : "run focus"
        : `${focus} focus`;

  preferences.push({
    source: "logistics",
    reason: `${from}-${to} becomes a ${focusNoun}.`,
    key: `focus_${focus}`,
    weight: 3,
  });

  if (redirected > 0) {
    rationale.push(
      `${blocked.join(" and ")} is unavailable for ${days} day${days === 1 ? "" : "s"}, ` +
        `so those days become a ${focusNoun} — about ${redirected} load redirected ` +
        `into ${focus}, which is where you have most to gain among what you can do.`
    );
  } else {
    rationale.push(
      `${blocked.join(" and ")} is unavailable for ${days} day${days === 1 ? "" : "s"}. ` +
        `Nothing is redirected: adding it to ${focus} would cost more than it gains.`
    );
  }

  if (deferred > 0) {
    rationale.push(
      `The remaining ${deferred} load is not repaid by piling it onto your long ` +
        `sessions. It moves to the week after ${to}, inside the normal ramp.`
    );
    // Explicitly NOT a hard constraint: the macro planner decides whether the
    // following week can absorb it, subject to the ramp cap.
    preferences.push({
      source: "logistics",
      reason: `Rebuild ${blocked.join(" and ")} volume after ${to}, within the ramp.`,
      key: `rebuild_${blocked[0]}`,
      weight: 2,
    });
  }

  return {
    blocked,
    focus,
    deferredLoad: deferred,
    redirectedLoad: redirected,
    constraints,
    preferences,
    rationale,
    facts: {
      blocked,
      days,
      lostLoad: Math.round(lostLoad),
      focus,
      redirected,
      deferred,
      absorption,
    },
  };
}

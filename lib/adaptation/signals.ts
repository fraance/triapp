/**
 * Signal engines (spec Part 4.2).
 *
 * Every engine here is a **pure function**: it takes state and returns
 * constraints and preferences. None of them touch the plan. That separation is
 * what makes the whole system testable and lets us explain any change by
 * replaying its inputs.
 *
 * Phase 1 implements the engines we have real data for. Readiness (HRV, sleep,
 * resting HR) is deliberately absent: Strava does not expose it and Garmin is
 * not connected, so there is nothing to compute from. Inventing a readiness
 * score would breach project rule 2.
 */
import {
  Constraint,
  LoadVector,
  SignalOutput,
  SolverSession,
  LOAD_COMPONENTS,
} from "./types";
import { totalLoad, acwr } from "./load-vector";

// ---- Execution drift ------------------------------------------------------

export interface CompletedSession {
  /** ISO yyyy-mm-dd. */
  date: string;
  discipline: string;
  /** What was actually done. */
  actualLoad: LoadVector;
  /** What had been planned for that session, if it was a planned one. */
  plannedLoad?: LoadVector;
}

export interface DriftOptions {
  /** Overshoot beyond this fraction triggers a hard constraint. */
  neuromuscularThreshold?: number;
  totalThreshold?: number;
  /** How many days back to consider. */
  lookbackDays?: number;
}

/**
 * Execution Drift Engine (spec 4.2).
 *
 * Compares what was planned against what was actually done. Overshooting
 * neuromuscular load by more than 15% blocks key sessions for 48 hours;
 * a large total overshoot caps load; a significant *undershoot* frees capacity
 * so the plan does not needlessly stay easy.
 */
export function executionDriftEngine(
  completed: CompletedSession[],
  today: string,
  opts: DriftOptions = {}
): SignalOutput {
  const neuroThreshold = opts.neuromuscularThreshold ?? 0.15;
  const totalThreshold = opts.totalThreshold ?? 0.2;
  const lookback = opts.lookbackDays ?? 3;

  const constraints: Constraint[] = [];
  const from = new Date(today + "T00:00:00");
  from.setDate(from.getDate() - lookback);
  const fromISO = from.toISOString().slice(0, 10);

  const recent = completed.filter((c) => c.date >= fromISO && c.date <= today);
  if (recent.length === 0) {
    return { constraints, preferences: [], facts: { recentSessions: 0 } };
  }

  let plannedTotal = 0;
  let actualTotal = 0;
  let plannedNeuro = 0;
  let actualNeuro = 0;
  let hasPlanned = false;

  for (const c of recent) {
    actualTotal += totalLoad(c.actualLoad);
    actualNeuro += c.actualLoad.neuromuscular;
    if (c.plannedLoad) {
      hasPlanned = true;
      plannedTotal += totalLoad(c.plannedLoad);
      plannedNeuro += c.plannedLoad.neuromuscular;
    }
  }

  // Without a planned baseline there is no drift to measure — say so rather
  // than assuming the athlete was on plan.
  if (!hasPlanned || plannedTotal === 0) {
    return {
      constraints,
      preferences: [],
      facts: { recentSessions: recent.length, comparable: false },
    };
  }

  const totalDrift = (actualTotal - plannedTotal) / plannedTotal;
  const neuroDrift =
    plannedNeuro > 0 ? (actualNeuro - plannedNeuro) / plannedNeuro : 0;

  const in48h = new Date(today + "T00:00:00");
  in48h.setDate(in48h.getDate() + 2);
  const in48hISO = in48h.toISOString().slice(0, 10);

  if (neuroDrift > neuroThreshold) {
    constraints.push({
      kind: "max_intensity",
      type: "hard",
      source: "execution_drift",
      reason:
        `High-intensity load over the last ${lookback} days came in ` +
        `${Math.round(neuroDrift * 100)}% above plan, so the legs need ` +
        `48 hours before another key session.`,
      fromDate: today,
      toDate: in48hISO,
      component: "neuromuscular",
      factor: 0.5,
    });
  }

  if (totalDrift > totalThreshold) {
    constraints.push({
      kind: "cap_load",
      type: "hard",
      source: "execution_drift",
      reason:
        `Total training load ran ${Math.round(totalDrift * 100)}% above plan, ` +
        `so the next two days are capped to bring the week back on target.`,
      fromDate: today,
      toDate: in48hISO,
      factor: Math.max(0.5, 1 - totalDrift),
    });
  }

  // A meaningful undershoot is a soft signal only: it frees capacity, but it
  // must never be able to force load upwards past a guardrail.
  if (totalDrift < -totalThreshold) {
    constraints.push({
      kind: "cap_load",
      type: "soft",
      source: "execution_drift",
      reason:
        `Training came in ${Math.round(Math.abs(totalDrift) * 100)}% below plan, ` +
        `so there is room to restore the week's intent.`,
      fromDate: today,
      toDate: in48hISO,
      factor: 1,
      weight: 0.5,
    });
  }

  return {
    constraints,
    preferences: [],
    facts: {
      recentSessions: recent.length,
      comparable: true,
      plannedTotal: Math.round(plannedTotal),
      actualTotal: Math.round(actualTotal),
      totalDriftPct: Math.round(totalDrift * 100),
      neuromuscularDriftPct: Math.round(neuroDrift * 100),
    },
  };
}

// ---- Missed session salvage (spec 4.2) -----------------------------------

export interface MissedSession {
  id: string;
  date: string;
  discipline: string;
  purpose: string;
  isAnchor: boolean;
  load: LoadVector;
}

export type SalvageAction = "reschedule" | "integrate" | "drop";

export interface SalvageDecision {
  sessionId: string;
  score: number;
  action: SalvageAction;
  reason: string;
}

/**
 * Missed-Session Engine (spec 4.2).
 *
 * Produces a continuous Salvage Score from purpose criticality, discipline
 * priority, and how much fatigue pressure there already is. Score decides:
 *   > 0.7  reschedule   0.35–0.7  integrate elsewhere   < 0.35  drop
 */
export function salvageEngine(
  missed: MissedSession[],
  opts: {
    /** 0..1 — how loaded the athlete already is. Higher means less salvage. */
    fatiguePressure?: number;
    /** Disciplines ranked by return on investment for the target race. */
    disciplinePriority?: Record<string, number>;
  } = {}
): SalvageDecision[] {
  const pressure = clamp01(opts.fatiguePressure ?? 0.5);
  const priority = opts.disciplinePriority ?? {};

  return missed.map((m) => {
    // Purpose criticality: anchors matter most, recovery least.
    const critical = m.isAnchor
      ? 1
      : /threshold|interval|vo2|race|long|key/i.test(m.purpose)
        ? 0.8
        : /endurance|base|steady|tempo/i.test(m.purpose)
          ? 0.55
          : /recovery|easy|mobility|technique/i.test(m.purpose)
            ? 0.2
            : 0.5;

    const roi = clamp01(priority[m.discipline.toLowerCase()] ?? 0.5);

    // Fatigue pressure reduces the case for cramming a session back in.
    const score = clamp01(critical * 0.55 + roi * 0.25 + (1 - pressure) * 0.2);

    const action: SalvageAction =
      score > 0.7 ? "reschedule" : score >= 0.35 ? "integrate" : "drop";

    const reason =
      action === "reschedule"
        ? `${m.discipline} on ${m.date} carries too much of the week's purpose to lose.`
        : action === "integrate"
          ? `${m.discipline} on ${m.date} is worth partially recovering inside another session.`
          : `${m.discipline} on ${m.date} is not worth the fatigue cost of catching up.`;

    return { sessionId: m.id, score: Math.round(score * 100) / 100, action, reason };
  });
}

// ---- Load-pressure helper -------------------------------------------------

/**
 * Turns acute vs chronic load into a single 0..1 "how cooked am I" figure,
 * used by the salvage engine and the solver's scoring.
 */
export function fatiguePressure(
  acute: LoadVector,
  chronic: LoadVector
): number {
  if (totalLoad(chronic) <= 0) return 0.5; // unknown — sit in the middle
  const ratios = acwr(acute, chronic);
  let worst = 0;
  for (const k of LOAD_COMPONENTS) {
    if (chronic[k] <= 0) continue;
    worst = Math.max(worst, ratios[k]);
  }
  // 0.8 -> 0, 1.5 -> 1
  return clamp01((worst - 0.8) / 0.7);
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

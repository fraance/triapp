/**
 * Function A — Risk assessment (defence).
 *
 * When the athlete reports fatigue or a niggle, the engine weighs what a
 * session would *gain* against what it might *cost*, and downgrades or rests
 * when the risk outweighs the reward. It does this without being asked.
 *
 * The asymmetry that governs everything here: a missed session costs a few
 * days of fitness. A stress fracture or an Achilles tendinopathy costs a
 * season. So the calculation is deliberately loss-averse — near the boundary
 * it backs off. LOGIC_V2 §0.5 is blunt about this being where age-groupers get
 * hurt, and it is the one failure an adaptive plan must never cause.
 *
 * Pure functions: report in, constraints out. Nothing here touches the plan.
 */
import { Constraint, LoadVector } from "./types";
import { ParsedReport, Niggle } from "./intent-parser";
import { totalLoad, localISO } from "./load-vector";

export interface RiskInput {
  report: ParsedReport;
  /** Acute:chronic ratio for the athlete right now, worst component. */
  acwr?: number | null;
  /** Estimated glycogen, 0-1, from the metabolic model. */
  glycogen?: number | null;
  /** Days until the A-race, so we can be firmer when there is time to spare. */
  daysToRace?: number | null;
}

export interface RiskAssessment {
  /** 0-1. Higher means more likely to do harm. */
  injuryRisk: number;
  /** 0-1. What a normal session would be worth today. */
  fitnessGain: number;
  /** What the engine decided. */
  decision: "proceed" | "downgrade" | "easy_only" | "rest";
  constraints: Constraint[];
  reasons: string[];
  facts: Record<string, unknown>;
}

/** A niggle's contribution to risk. Pain is weighted far above soreness. */
function niggleRisk(n: Niggle): number {
  const base =
    n.severity === "painful" ? 0.7 : n.severity === "sore" ? 0.35 : 0.15;
  // A stated pain score overrides the adjective — it is more precise.
  if (n.painScale != null) {
    // 0-2 trivial, 3-4 caution, 5-6 serious, 7+ stop.
    return Math.max(base, Math.min(1, n.painScale / 8));
  }
  return base;
}

/** Sites where continuing to load risks a long lay-off, not just soreness. */
export function isHighConsequenceSite(site: string): boolean {
  return /achilles|shin|stress|bone|plantar|tendon|itb|knee|hip|back/i.test(site);
}

export function assessRisk(input: RiskInput, today: string): RiskAssessment {
  const { report } = input;
  const reasons: string[] = [];
  const constraints: Constraint[] = [];

  // ---- Injury risk -------------------------------------------------------
  let risk = 0;

  const worstNiggle = report.niggles
    .map((n) => ({ n, r: niggleRisk(n) }))
    .sort((a, b) => b.r - a.r)[0];

  if (worstNiggle) {
    risk = Math.max(risk, worstNiggle.r);
    if (isHighConsequenceSite(worstNiggle.n.site)) {
      // Tendon and bone injuries do not warn twice.
      risk = Math.min(1, risk + 0.2);
      reasons.push(
        `${worstNiggle.n.site} is a site where training through it turns days off into months off.`
      );
    }
  }

  if (report.fatigue != null && report.fatigue > 0.6) {
    risk = Math.min(1, risk + (report.fatigue - 0.6) * 0.75);
    reasons.push("You are carrying more fatigue than usual.");
  }

  if (report.sleepQuality != null && report.sleepQuality < 0.4) {
    risk = Math.min(1, risk + (0.4 - report.sleepQuality) * 0.5);
    reasons.push("Poor sleep blunts both adaptation and coordination.");
  }

  if (report.alcoholUnits != null && report.alcoholUnits >= 2) {
    risk = Math.min(1, risk + Math.min(0.2, report.alcoholUnits * 0.05));
    reasons.push("Alcohol the night before impairs recovery and thermoregulation.");
  }

  if (report.stress != null && report.stress > 0.7) {
    risk = Math.min(1, risk + 0.1);
    reasons.push("High life stress adds to the same allostatic load as training.");
  }

  if (input.acwr != null && input.acwr > 1.3) {
    risk = Math.min(1, risk + Math.min(0.25, (input.acwr - 1.3) * 0.5));
    reasons.push(
      `Your acute:chronic load ratio is ${input.acwr.toFixed(2)}, already above the safe band.`
    );
  }

  if (report.illness) {
    risk = 1;
    reasons.push("Training through illness risks turning a week off into a month.");
  }

  // ---- Fitness gain ------------------------------------------------------
  // What a normal session is actually worth today. Fatigue and empty stores
  // reduce the adaptation a hard session produces — that is the whole point:
  // the cost rises while the benefit falls.
  let gain = 1;
  if (report.fatigue != null) gain -= report.fatigue * 0.5;
  if (input.glycogen != null && input.glycogen < 0.5) {
    gain -= (0.5 - input.glycogen) * 0.6;
    reasons.push("Low fuel stores mean a hard session would cost more than it returns.");
  }
  if (report.sleepQuality != null && report.sleepQuality < 0.5) {
    gain -= (0.5 - report.sleepQuality) * 0.4;
  }
  gain = Math.max(0, Math.min(1, gain));

  // ---- Decision ----------------------------------------------------------
  // Loss-averse: risk must be clearly below gain to train normally.
  let decision: RiskAssessment["decision"];
  if (risk >= 0.75) decision = "rest";
  else if (risk >= 0.5) decision = "easy_only";
  else if (risk > gain * 0.8) decision = "downgrade";
  else decision = "proceed";

  // Close to the race the calculation changes shape: there is no fitness left
  // to gain that could justify arriving compromised, so the bar for training
  // normally rises rather than staying where it was.
  if (input.daysToRace != null && input.daysToRace <= 10) {
    const raceWeekConcern =
      risk > 0.25 || (report.fatigue != null && report.fatigue > 0.6);
    if (raceWeekConcern) {
      decision =
        decision === "proceed"
          ? "downgrade"
          : decision === "downgrade"
            ? "easy_only"
            : decision;
      reasons.push(
        `With ${input.daysToRace} days to your race, nothing gained now is worth ` +
          `arriving tired or sore.`
      );
    }
  }

  const from = report.fromDate || today;
  const to = report.toDate || today;

  if (decision === "rest") {
    constraints.push({
      kind: "rest_day",
      type: "hard",
      source: "risk_assessment",
      reason:
        reasons[0] ??
        "What you have reported puts the risk of harm above anything a session would gain.",
      fromDate: from,
      toDate: to,
    });
  } else if (decision === "easy_only") {
    constraints.push({
      kind: "max_intensity",
      type: "hard",
      source: "risk_assessment",
      reason:
        reasons[0] ??
        "Intensity is capped while the risk of harm outweighs the gain.",
      fromDate: from,
      toDate: to,
      component: "neuromuscular",
      factor: 0.3,
    });
    constraints.push({
      kind: "cap_load",
      type: "hard",
      source: "risk_assessment",
      reason: "Volume is held down alongside intensity.",
      fromDate: from,
      toDate: to,
      factor: 0.6,
    });
  } else if (decision === "downgrade") {
    constraints.push({
      kind: "cap_load",
      type: "hard",
      source: "risk_assessment",
      reason:
        reasons[0] ?? "Today is worth less than usual, so the session is eased.",
      fromDate: from,
      toDate: to,
      factor: 0.75,
    });
  }

  // A niggle constrains the disciplines that load it, whatever the overall
  // decision — you can swim on a sore Achilles.
  for (const n of report.niggles) {
    if (niggleRisk(n) < 0.3) continue;
    const affected = n.affects.length > 0 ? n.affects : [];
    if (affected.length === 0) continue;
    constraints.push({
      kind: "max_intensity",
      type: "hard",
      source: "risk_assessment",
      reason:
        `Your ${n.site} is ${n.severity}, so ${affected.join(" and ")} load is ` +
        `held down until it settles.`,
      fromDate: from,
      toDate: to,
      component: affected.includes("swim") ? "upper" : "mechanical",
      factor: niggleRisk(n) >= 0.6 ? 0.3 : 0.6,
    });
  }

  return {
    injuryRisk: Math.round(risk * 100) / 100,
    fitnessGain: Math.round(gain * 100) / 100,
    decision,
    constraints,
    reasons,
    facts: {
      injuryRisk: Math.round(risk * 100) / 100,
      fitnessGain: Math.round(gain * 100) / 100,
      decision,
      niggles: report.niggles.map((n) => `${n.site}:${n.severity}`),
      acwr: input.acwr ?? null,
    },
  };
}

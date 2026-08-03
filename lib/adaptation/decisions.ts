/**
 * Decisions the engine puts to the athlete.
 *
 * The engine decides almost everything by itself — that is the product. But a
 * few choices are genuinely not its to make:
 *
 *   - How hard to come back after time off. The safe answer and the right
 *     answer are not always the same, and only the athlete knows whether the
 *     break was injury, illness or a holiday.
 *   - Whether to rebuild a plan that no longer fits. That throws away work
 *     they may be attached to.
 *
 * Previously these surfaced as a conversation with whoever was building the
 * app. They belong in the product: the engine states the evidence and the
 * options, the athlete chooses, and the answer is remembered so the same
 * question is never asked twice.
 *
 * Deliberately narrow. Every question added here is cognitive load, which v3's
 * North Star spends carefully: "the athlete should never be asked a question
 * they don't have new information to answer."
 */
import { prisma } from "../prisma";

export interface DecisionOption {
  id: string;
  label: string;
  detail: string;
  recommended?: boolean;
}

export interface PendingDecision {
  id: string;
  kind: string;
  question: string;
  context: string;
  options: DecisionOption[];
  facts: Record<string, unknown> | null;
}

/**
 * Raises a decision, or updates it if the evidence has moved on.
 *
 * A decision the athlete has already answered is never re-asked — that is the
 * whole point of storing the answer.
 */
export async function raiseDecision(
  userId: string,
  decision: {
    kind: string;
    question: string;
    context: string;
    options: DecisionOption[];
    facts?: Record<string, unknown>;
  }
): Promise<void> {
  const existing = await prisma.planDecision.findUnique({
    where: { userId_kind: { userId, kind: decision.kind } },
    select: { status: true },
  });

  if (existing?.status === "answered") return;

  await prisma.planDecision.upsert({
    where: { userId_kind: { userId, kind: decision.kind } },
    create: {
      userId,
      kind: decision.kind,
      question: decision.question,
      context: decision.context,
      options: decision.options as object,
      facts: (decision.facts ?? null) as object,
    },
    update: {
      question: decision.question,
      context: decision.context,
      options: decision.options as object,
      facts: (decision.facts ?? null) as object,
    },
  });
}

export async function getPendingDecisions(userId: string): Promise<PendingDecision[]> {
  const rows = await prisma.planDecision.findMany({
    where: { userId, status: "pending" },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    question: r.question,
    context: r.context,
    options: (r.options as unknown as DecisionOption[]) ?? [],
    facts: (r.facts as Record<string, unknown>) ?? null,
  }));
}

/** Clears a question that no longer applies, without pretending it was answered. */
export async function withdrawDecision(userId: string, kind: string): Promise<void> {
  await prisma.planDecision
    .updateMany({
      where: { userId, kind, status: "pending" },
      data: { status: "expired" },
    })
    .catch(() => {});
}

// ---- The decisions themselves --------------------------------------------

export const RAMP_AFTER_BREAK = "ramp_after_break";
export const REBUILD_PLAN = "rebuild_plan";

/**
 * After time off, the engine ramps from where the athlete resumed, and does so
 * cautiously. That is the safe default and it is often right — but it can also
 * be far below what they are capable of, and only they know why they stopped.
 */
export async function askAboutComeback(
  userId: string,
  facts: {
    recentWeeklyLoad: number;
    peakWeeklyLoad: number;
    weekOneLoad: number;
    weekOneHours: number;
    weeksToRace: number;
  }
): Promise<void> {
  // Only worth asking if the gap is actually large. A conservative start that
  // is close to their best is not a question, it is just the plan.
  if (facts.peakWeeklyLoad < facts.recentWeeklyLoad * 1.6) {
    await withdrawDecision(userId, RAMP_AFTER_BREAK);
    return;
  }

  await raiseDecision(userId, {
    kind: RAMP_AFTER_BREAK,
    question: "How hard should we rebuild after your break?",
    context:
      `You've been back for a couple of weeks at about ${Math.round(facts.recentWeeklyLoad)} ` +
      `load a week. Your best week this season was ${Math.round(facts.peakWeeklyLoad)}. ` +
      `Coming back from time off, tissue tolerance lags fitness, so your plan ` +
      `currently starts at ${Math.round(facts.weekOneLoad)} (about ${facts.weekOneHours} h) ` +
      `and builds 5% a week. With ${facts.weeksToRace} weeks to your race, that is ` +
      `deliberately cautious.`,
    options: [
      {
        id: "cautious",
        label: "Rebuild carefully (5% a week)",
        detail:
          "The safe route. Comebacks are when people get hurt, and an injury now " +
          "costs the race outright.",
        recommended: true,
      },
      {
        id: "standard",
        label: "Normal progression (8% a week)",
        detail:
          "For a break that was life, not injury — a holiday or work. Still inside " +
          "the guardrail, just less conservative.",
      },
      {
        id: "assertive",
        label: "Push it (10% a week)",
        detail:
          "Only if you stopped for reasons unrelated to your body and you felt " +
          "strong when you stopped. This raises injury risk and the engine will " +
          "hold the impact-load limit regardless.",
      },
    ],
    facts,
  });
}

/**
 * The plan no longer fits what the athlete is doing, and adaptation cannot
 * bridge the gap. Rebuilding discards work, so it is offered, not imposed.
 */
export async function askAboutRebuild(
  userId: string,
  facts: {
    plannedWeekLoad: number;
    sustainableLoad: number;
    reason: string;
  }
): Promise<void> {
  await raiseDecision(userId, {
    kind: REBUILD_PLAN,
    question: "Your plan no longer matches what you're actually training. Rebuild it?",
    context:
      `The coming week asks for about ${Math.round(facts.plannedWeekLoad)} load, but ` +
      `you have been sustaining around ${Math.round(facts.sustainableLoad)}. That gap is ` +
      `wide enough that day-to-day adjustments cannot close it — ${facts.reason}. ` +
      `Rebuilding writes a plan around what you are actually doing.`,
    options: [
      {
        id: "rebuild",
        label: "Rebuild my plan",
        detail:
          "Regenerates every remaining week around your current training, inside " +
          "the safety limits. Your completed sessions are untouched.",
        recommended: true,
      },
      {
        id: "keep",
        label: "Leave it as it is",
        detail:
          "Keeps the plan. Expect sessions to keep being eased or moved, and to be " +
          "told when a week cannot be made to fit.",
      },
    ],
    facts,
  });
}

// ---- Applying an answer ---------------------------------------------------

export const RAMP_BY_ANSWER: Record<string, number> = {
  cautious: 0.05,
  standard: 0.08,
  assertive: 0.1,
};

export interface AnswerResult {
  applied: boolean;
  message: string;
  /** The plan needs regenerating for this answer to take effect. */
  requiresRebuild?: boolean;
}

/**
 * Records the athlete's answer and makes it take effect.
 *
 * An answer that changes nothing would be worse than not asking: it teaches
 * the athlete their input is decorative.
 */
export async function answerDecision(
  userId: string,
  kind: string,
  answer: string
): Promise<AnswerResult> {
  const decision = await prisma.planDecision.findUnique({
    where: { userId_kind: { userId, kind } },
  });
  if (!decision || decision.status !== "pending") {
    return { applied: false, message: "That question is no longer open." };
  }

  const options = (decision.options as unknown as DecisionOption[]) ?? [];
  if (!options.some((o) => o.id === answer)) {
    return { applied: false, message: "That is not one of the options." };
  }

  await prisma.planDecision.update({
    where: { id: decision.id },
    data: { status: "answered", answer, answeredAt: new Date() },
  });

  if (kind === RAMP_AFTER_BREAK) {
    const rampRate = RAMP_BY_ANSWER[answer];
    const profile = await prisma.athleteProfile.findUnique({
      where: { userId },
      select: { trainingPreferences: true },
    });
    const prefs =
      profile?.trainingPreferences && typeof profile.trainingPreferences === "object"
        ? (profile.trainingPreferences as Record<string, unknown>)
        : {};

    await prisma.athleteProfile.upsert({
      where: { userId },
      create: { userId, trainingPreferences: { ...prefs, rampRate } } as never,
      update: { trainingPreferences: { ...prefs, rampRate } } as never,
    });

    return {
      applied: true,
      requiresRebuild: true,
      message:
        `Noted — rebuilding at ${Math.round(rampRate * 100)}% a week. ` +
        `Regenerate your plan for this to take effect.`,
    };
  }

  if (kind === REBUILD_PLAN) {
    return answer === "rebuild"
      ? {
          applied: true,
          requiresRebuild: true,
          message: "Rebuilding your plan around what you're actually training.",
        }
      : {
          applied: true,
          message:
            "Left as it is. I'll keep adjusting day to day and tell you when a " +
            "week cannot be made to fit.",
        };
  }

  return { applied: true, message: "Noted." };
}

/** The athlete's chosen ramp, if they have expressed one. */
export async function preferredRampRate(userId: string): Promise<number | null> {
  const profile = await prisma.athleteProfile.findUnique({
    where: { userId },
    select: { trainingPreferences: true },
  });
  const prefs = profile?.trainingPreferences as Record<string, unknown> | null;
  const rate = prefs?.rampRate;
  return typeof rate === "number" && rate > 0 && rate <= 0.15 ? rate : null;
}

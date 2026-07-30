/**
 * Narrator (spec Part 4.5 and Part 7).
 *
 * The LLM's role is deliberately tiny. It is **forbidden** from computing load,
 * scheduling, or evaluating guardrails — all of that has already happened
 * deterministically by the time we get here. Its only job is to turn a decided
 * struct into a sentence the athlete trusts.
 *
 * Required shape: cause -> action -> what it protects.
 *
 * If the LLM is unavailable we fall back to a deterministic sentence rather
 * than failing the adaptation: the athlete must always get an explanation.
 */
import OpenAI from "openai";
import { Constraint, PlanDiff } from "./types";

const MODEL = "gpt-4o-mini";

export interface NarrationInput {
  trigger: string;
  constraints: Constraint[];
  diff: PlanDiff;
  facts?: Record<string, unknown>;
}

/**
 * Deterministic explanation, used as a fallback and as the basis for the LLM
 * prompt. Never fabricates: it only restates what actually changed.
 */
export function describeChanges(input: NarrationInput): string {
  const { diff, constraints } = input;
  if (diff.empty || diff.changes.length === 0) return "No changes were needed.";

  const cause =
    constraints.find((c) => c.type === "hard")?.reason ??
    constraints[0]?.reason ??
    "Your recent training differed from the plan.";

  const parts = diff.changes.map((c) => {
    switch (c.change) {
      case "moved":
        return `${c.discipline} moved from ${c.fromDate} to ${c.toDate}`;
      case "scaled":
        return `${c.discipline} on ${c.toDate ?? c.fromDate} eased from ${c.fromTss} to ${c.toTss} load`;
      case "dropped":
        return `${c.discipline} on ${c.fromDate} dropped`;
      case "retyped":
        return `${c.discipline} on ${c.fromDate} changed from ${c.fromType} to ${c.toType}`;
      default:
        return `${c.discipline} on ${c.fromDate} adjusted`;
    }
  });

  return `${cause} ${parts.join("; ")}.`;
}

/**
 * Asks the LLM to phrase the change. Falls back to `describeChanges` on any
 * error, so an adaptation is never blocked by the model being down.
 */
export async function narrate(input: NarrationInput): Promise<string> {
  const deterministic = describeChanges(input);
  if (input.diff.empty) return deterministic;
  if (!process.env.OPENAI_API_KEY) return deterministic;

  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const response = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.2,
      max_tokens: 150,
      messages: [
        {
          role: "system",
          content: [
            "You explain training plan changes to an experienced age-group triathlete.",
            "Follow exactly this shape: cause -> action -> what it protects.",
            "Two or three sentences maximum. Plain, direct, no cheerleading.",
            "You must ONLY use the facts given. Never invent numbers, paces,",
            "dates, physiological claims or sessions that are not listed.",
            "Do not add advice beyond what the change already implies.",
          ].join(" "),
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              trigger: input.trigger,
              why: input.constraints.map((c) => c.reason),
              changes: input.diff.changes,
              measurements: input.facts ?? {},
            },
            null,
            2
          ),
        },
      ],
    });

    const text = response.choices[0]?.message?.content?.trim();
    return text && text.length > 0 ? text : deterministic;
  } catch (e) {
    console.error("[adaptation] narration failed, using deterministic text:", e);
    return deterministic;
  }
}

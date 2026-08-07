/**
 * A second, narrower LLM parse (v3 §7's same boundary): recognizing a direct
 * scheduling instruction — "move Thursday's swim to Saturday", "swap my long
 * ride and Sunday's rest day" — separately from the physiological/logistics
 * report the coach already understands.
 *
 * The model only identifies which of the athlete's OWN listed sessions they
 * mean and a candidate date. It never decides whether the move is wise or
 * legal — that is `applyMoves`'s job, the same guardrail-checked path the
 * calendar's drag-and-drop uses. Every field the model returns is checked
 * against the list actually given to it before anything is trusted.
 */
import OpenAI from "openai";

const MODEL = "gpt-4o-mini";

export interface ScheduleSession {
  /** Opaque reference the model must echo back verbatim — never a real id,
   * so a hallucinated token can never collide with one that matters. */
  token: string;
  date: string; // yyyy-mm-dd
  day: string; // weekday name
  discipline: string;
  type: string;
  isAnchor: boolean;
}

export interface ScheduleAction {
  kind: "move" | "swap" | "none";
  sessionToken: string | null;
  toDate: string | null;
  otherToken: string | null;
}

const NONE: ScheduleAction = {
  kind: "none",
  sessionToken: null,
  toDate: null,
  otherToken: null,
};

function isValidIsoDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00");
  return !Number.isNaN(d.getTime());
}

export function validateScheduleAction(
  raw: unknown,
  sessions: ScheduleSession[]
): ScheduleAction {
  if (!raw || typeof raw !== "object") return NONE;
  const r = raw as Record<string, unknown>;
  const tokens = new Set(sessions.map((s) => s.token));

  if (r.kind === "move") {
    const sessionToken =
      typeof r.sessionToken === "string" && tokens.has(r.sessionToken)
        ? r.sessionToken
        : null;
    const toDate = isValidIsoDate(r.toDate) ? r.toDate : null;
    if (!sessionToken || !toDate) return NONE;
    return { kind: "move", sessionToken, toDate, otherToken: null };
  }
  if (r.kind === "swap") {
    const a =
      typeof r.sessionToken === "string" && tokens.has(r.sessionToken)
        ? r.sessionToken
        : null;
    const b =
      typeof r.otherToken === "string" && tokens.has(r.otherToken)
        ? r.otherToken
        : null;
    if (!a || !b || a === b) return NONE;
    return { kind: "swap", sessionToken: a, otherToken: b, toDate: null };
  }
  return NONE;
}

/**
 * @param sessions the athlete's own upcoming, movable sessions — the only
 *   ones a move or swap can ever refer to.
 */
export async function parseScheduleRequest(
  text: string,
  today: string,
  sessions: ScheduleSession[]
): Promise<ScheduleAction> {
  if (!text.trim() || sessions.length === 0) return NONE;
  if (!process.env.OPENAI_API_KEY) return NONE;

  const todayWeekday = new Date(today + "T00:00:00").toLocaleDateString(
    "en-US",
    { weekday: "long" }
  );
  const listing = sessions
    .map(
      (s) =>
        `${s.token}: ${s.day} ${s.date} — ${s.discipline} ${s.type}${
          s.isAnchor ? " (key session)" : ""
        }`
    )
    .join("\n");

  const system = [
    "You identify whether an athlete is asking to MOVE or SWAP one of their own",
    "upcoming training sessions. You are a parser, not a scheduler — you never",
    "decide whether a move is wise, only which session(s) and date they mean.",
    "",
    'Return ONLY JSON: { "kind": "move"|"swap"|"none", "sessionToken": string|null,',
    '"toDate": "yyyy-mm-dd"|null, "otherToken": string|null }',
    "",
    "Rules:",
    "- sessionToken and otherToken MUST be one of the tokens listed below,",
    "  copied verbatim. Never invent a token or a session.",
    '- kind "move": sessionToken is the session being moved, toDate is the',
    "  destination date, worked out from what the athlete said and today's date.",
    '- kind "swap": sessionToken and otherToken are the two sessions to trade',
    "  dates; leave toDate null.",
    '- kind "none": nothing here is a scheduling instruction. A report about how',
    "  they feel, or a question, is NOT a scheduling instruction on its own.",
  ].join("\n");

  const user = [
    `Today is ${today} (${todayWeekday}).`,
    "",
    "The athlete's own upcoming sessions:",
    listing,
    "",
    `Athlete says: ${text}`,
  ].join("\n");

  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const res = await client.chat.completions.create({
      model: MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    const content = res.choices[0]?.message?.content;
    if (!content) return NONE;
    return validateScheduleAction(JSON.parse(content), sessions);
  } catch (e) {
    console.error("[schedule-intent] failed:", e);
    return NONE;
  }
}
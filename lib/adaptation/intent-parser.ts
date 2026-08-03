/**
 * Intent parser (v3 §7: the LLM's second permitted role — "converting
 * unstructured voice/text input into structured constraint modifications").
 *
 * The boundary is strict and load-bearing: this module turns words into facts.
 * It does not decide anything. It never says "so take a rest day", never
 * computes load, never touches the plan. Every decision that follows is made
 * by deterministic code from the structure produced here, which is why an
 * adaptation can always be explained and replayed.
 *
 * Everything the model returns is validated before use. An LLM asked for JSON
 * will occasionally invent a field, a date in the wrong century, or a pain
 * score of 47; none of that may reach the engine.
 */
import OpenAI from "openai";
import { localISO } from "./load-vector";

const MODEL = "gpt-4o-mini";

export type NiggleSeverity = "niggle" | "sore" | "painful";

export interface Niggle {
  /** Body part in the athlete's own words, normalised where obvious. */
  site: string;
  severity: NiggleSeverity;
  /** 0-10 if they gave one. Never invented. */
  painScale: number | null;
  /** Which disciplines load this site. */
  affects: string[];
}

export interface ParsedReport {
  /** 0-1, how tired they say they are. Null when they did not say. */
  fatigue: number | null;
  /** 0-1 sleep quality. Null when unmentioned. */
  sleepQuality: number | null;
  /** Alcohol units mentioned, if any. */
  alcoholUnits: number | null;
  /** 0-1 life stress. */
  stress: number | null;
  illness: boolean;
  niggles: Niggle[];

  /** Disciplines they cannot do in this window. */
  unavailableDisciplines: string[];
  /** Disciplines they explicitly can do — a beach means open water swimming. */
  availableDisciplines: string[];
  /** Kit they do not have. */
  missingEquipment: string[];
  /** Where they are, if it matters. */
  location: string | null;
  travelling: boolean;

  /** ISO yyyy-mm-dd. */
  fromDate: string;
  toDate: string;

  /** True when the text carried nothing actionable. */
  empty: boolean;
  /** Anything the parser could not resolve, surfaced rather than guessed. */
  unresolved: string[];
}

const EMPTY = (today: string): ParsedReport => ({
  fatigue: null,
  sleepQuality: null,
  alcoholUnits: null,
  stress: null,
  illness: false,
  niggles: [],
  unavailableDisciplines: [],
  availableDisciplines: [],
  missingEquipment: [],
  location: null,
  travelling: false,
  fromDate: today,
  toDate: today,
  empty: true,
  unresolved: [],
});

/** Which disciplines load a given body part — used to target constraints. */
export function disciplinesLoading(site: string): string[] {
  const s = site.toLowerCase();
  if (/achilles|calf|shin|foot|plantar|ankle|knee|hamstring|itb|hip|quad|glute/.test(s))
    return ["run", "bike"];
  if (/shoulder|lat|neck|elbow|wrist|rotator/.test(s)) return ["swim"];
  if (/back|core|abdomen/.test(s)) return ["run", "bike", "swim"];
  return [];
}

function clamp01(n: unknown): number | null {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.max(0, Math.min(1, v));
}

function normaliseDisciplineName(raw: unknown): string | null {
  const d = String(raw ?? "").toLowerCase();
  if (!d) return null;
  if (d.includes("swim")) return "swim";
  if (d.includes("bike") || d.includes("cycl") || d.includes("ride")) return "bike";
  if (d.includes("run")) return "run";
  if (d.includes("strength") || d.includes("gym")) return "strength";
  return null;
}

/**
 * Validates and clamps whatever the model returned.
 *
 * Deliberately paranoid. A hallucinated 90-day horizon or a pain score of 47
 * would silently reshape months of training.
 */
/**
 * Words that must appear before a physiological field may be populated.
 *
 * Models asked for "null when unknown" routinely return 0 instead, and 0 is a
 * legitimate value — "didn't sleep at all" is not the same as "didn't mention
 * sleep". A message about a missing bike was arriving with sleepQuality 0 and
 * manufacturing injury risk out of nothing. This gate is deterministic: if the
 * athlete never raised the subject, the engine does not get an opinion on it.
 */
const MENTIONS: Record<string, RegExp> = {
  fatigue: /tired|fatigu|exhaust|knacker|wrecked|flat|heavy legs|drained|shattered|no energy/i,
  sleepQuality: /sleep|slept|insomnia|awake|rested|bed|nap/i,
  alcoholUnits: /wine|beer|drink|drank|alcohol|pint|cocktail|gin|whisky|vodka/i,
  stress: /stress|anxious|pressure|overwhelm|busy at work|deadline/i,
};

export function validateParsed(
  raw: unknown,
  today: string,
  maxHorizonDays = 21,
  /** The athlete's own words, used to gate the physiological fields. */
  rawText = ""
): ParsedReport {
  const base = EMPTY(today);
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;

  const niggles: Niggle[] = Array.isArray(r.niggles)
    ? (r.niggles as unknown[])
        .map((n) => {
          if (!n || typeof n !== "object") return null;
          const o = n as Record<string, unknown>;
          const site = String(o.site ?? "").trim();
          if (!site) return null;
          const severity: NiggleSeverity =
            o.severity === "painful" || o.severity === "sore" ? o.severity : "niggle";
          const painRaw = Number(o.painScale);
          const painScale =
            Number.isFinite(painRaw) && painRaw >= 0 && painRaw <= 10
              ? Math.round(painRaw)
              : null;
          const affects = Array.isArray(o.affects)
            ? (o.affects.map(normaliseDisciplineName).filter(Boolean) as string[])
            : [];
          return {
            site,
            severity,
            painScale,
            affects: affects.length > 0 ? affects : disciplinesLoading(site),
          };
        })
        .filter((n): n is Niggle => n !== null)
    : [];

  const dedupe = (v: unknown): string[] =>
    Array.isArray(v)
      ? [...new Set(v.map(normaliseDisciplineName).filter(Boolean) as string[])]
      : [];

  // Dates: clamp to a sane window. A parser that returns 2027 must not be able
  // to suppress a year of training.
  const parseDate = (v: unknown, fallback: string): string => {
    const s = String(v ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return fallback;
    const d = new Date(s + "T00:00:00");
    if (Number.isNaN(d.getTime())) return fallback;
    return s;
  };

  let fromDate = parseDate(r.fromDate, today);
  let toDate = parseDate(r.toDate, fromDate);
  if (fromDate < today) fromDate = today;
  if (toDate < fromDate) toDate = fromDate;

  const maxTo = new Date(today + "T00:00:00");
  maxTo.setDate(maxTo.getDate() + maxHorizonDays);
  if (toDate > localISO(maxTo)) toDate = localISO(maxTo);

  const unavailable = dedupe(r.unavailableDisciplines);
  const available = dedupe(r.availableDisciplines);
  const missingEquipment = Array.isArray(r.missingEquipment)
    ? r.missingEquipment.map((e) => String(e).toLowerCase()).filter(Boolean)
    : [];

  // Only honour a physiological reading if the athlete actually raised it.
  const gate = <T>(field: string, value: T): T | null =>
    rawText && !MENTIONS[field]?.test(rawText) ? null : value;

  const parsed: ParsedReport = {
    fatigue: gate("fatigue", clamp01(r.fatigue)),
    sleepQuality: gate("sleepQuality", clamp01(r.sleepQuality)),
    alcoholUnits: gate(
      "alcoholUnits",
      Number.isFinite(Number(r.alcoholUnits)) && Number(r.alcoholUnits) >= 0
        ? Math.min(30, Number(r.alcoholUnits))
        : null
    ),
    stress: gate("stress", clamp01(r.stress)),
    illness: r.illness === true,
    niggles,
    unavailableDisciplines: unavailable,
    availableDisciplines: available.filter((d) => !unavailable.includes(d)),
    missingEquipment,
    location: r.location ? String(r.location).slice(0, 80) : null,
    travelling: r.travelling === true,
    fromDate,
    toDate,
    empty: false,
    unresolved: Array.isArray(r.unresolved)
      ? r.unresolved.map((u) => String(u)).slice(0, 5)
      : [],
  };

  parsed.empty =
    parsed.fatigue === null &&
    parsed.sleepQuality === null &&
    parsed.alcoholUnits === null &&
    parsed.stress === null &&
    !parsed.illness &&
    parsed.niggles.length === 0 &&
    parsed.unavailableDisciplines.length === 0 &&
    parsed.availableDisciplines.length === 0 &&
    parsed.missingEquipment.length === 0 &&
    !parsed.travelling;

  return parsed;
}

const SYSTEM_PROMPT = [
  "You convert an athlete's message into structured facts. You are a parser,",
  "not a coach. Never give advice, never decide anything about training.",
  "",
  "Return ONLY JSON with these keys:",
  "  fatigue          0-1 or null (how tired they say they are)",
  "  sleepQuality     0-1 or null (1 = slept well)",
  "  alcoholUnits     number or null",
  "  stress           0-1 or null",
  "  illness          boolean",
  "  niggles          [{ site, severity: niggle|sore|painful, painScale: 0-10 or null }]",
  "  unavailableDisciplines  subset of [swim, bike, run, strength]",
  "  availableDisciplines    subset of the same",
  "  missingEquipment        e.g. [bike, wetsuit, pool]",
  "  location         short string or null",
  "  travelling       boolean",
  "  fromDate         yyyy-mm-dd",
  "  toDate           yyyy-mm-dd",
  "  unresolved       array of things you could not determine",
  "",
  "Rules:",
  "- Use null when they did not say. NEVER guess a number they did not give.",
  "- 'no bike for 4 days' -> unavailableDisciplines [bike], toDate = today + 3.",
  "- 'at the beach, only open water swimming' -> availableDisciplines [swim],",
  "  unavailableDisciplines [bike, run] ONLY if they imply they cannot do them.",
  "- A body part that hurts is a niggle. severity 'painful' if they say pain,",
  "  'sore' if soreness, otherwise 'niggle'.",
  "- If no date is implied, fromDate and toDate are both today.",
].join("\n");

/**
 * Parses an athlete's message.
 *
 * Falls back to an empty report if the model is unavailable — the caller then
 * tells the athlete it could not read the message, rather than the engine
 * acting on a guess.
 */
export async function parseAthleteMessage(
  text: string,
  today: string
): Promise<ParsedReport> {
  if (!text.trim()) return EMPTY(today);
  if (!process.env.OPENAI_API_KEY) return EMPTY(today);

  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const res = await client.chat.completions.create({
      model: MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Today is ${today}.\n\nAthlete says: ${text}` },
      ],
    });

    const content = res.choices[0]?.message?.content;
    if (!content) return EMPTY(today);
    return validateParsed(JSON.parse(content), today, 21, text);
  } catch (e) {
    console.error("[intent-parser] failed:", e);
    return EMPTY(today);
  }
}

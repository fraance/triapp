/**
 * Predictive race-day profiling.
 *
 * Given a race name and date, we ask the model what it knows about the course
 * — swim environment, elevation, typical climate — and it must state its own
 * confidence and explicitly list what it could NOT determine.
 *
 * IMPORTANT: the model has no live internet access here, so anything it
 * returns is treated as a SUGGESTION that the athlete must confirm. We never
 * silently train someone on invented elevation figures.
 */
import { OpenAI } from "openai";

let client: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}

export interface RaceResearchResult {
  raceName: string | null;
  location: string | null;
  swimEnvironment: string | null;
  waterTempC: number | null;
  wetsuitLikely: boolean | null;
  swimNotes: string | null;
  bikeElevationGainM: number | null;
  bikeCourseType: string | null;
  bikeNotes: string | null;
  runElevationGainM: number | null;
  runCourseType: string | null;
  runSurface: string | null;
  runNotes: string | null;
  expectedTempC: number | null;
  expectedHumidity: number | null;
  windNotes: string | null;
  aiConfidence: "high" | "medium" | "low";
  /** Fields the model could not determine — we ask the athlete for these. */
  unknownFields: string[];
  questionsForAthlete: string[];
  /** True only when the sources clearly describe THIS specific race. */
  raceIdentified: boolean;
  /** URLs the facts were taken from, when live web search was used. */
  sources: string[];
  /** True when the answer came from a live web search rather than memory. */
  usedWebSearch: boolean;
}

const EMPTY_RESULT: RaceResearchResult = {
  raceName: null,
  location: null,
  swimEnvironment: null,
  waterTempC: null,
  wetsuitLikely: null,
  swimNotes: null,
  bikeElevationGainM: null,
  bikeCourseType: null,
  bikeNotes: null,
  runElevationGainM: null,
  runCourseType: null,
  runSurface: null,
  runNotes: null,
  expectedTempC: null,
  expectedHumidity: null,
  windNotes: null,
  aiConfidence: "low",
  unknownFields: [],
  questionsForAthlete: [],
  raceIdentified: false,
  sources: [],
  usedWebSearch: false,
};

/** Questions we fall back to when the race can't be identified. */
export const FALLBACK_QUESTIONS = [
  "Is the swim in the sea, a lake, a river, or a pool?",
  "Roughly what water temperature do you expect, and are wetsuits allowed?",
  "How hilly is the bike course — flat, rolling, hilly, or mountainous? Any idea of total elevation gain?",
  "How hilly is the run course, and is it road, trail, or mixed?",
  "What weather do you expect on race day — typical temperature, humidity, wind?",
];

function toNum(v: any): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toStr(v: any): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || /^(unknown|n\/a|null)$/i.test(s)) return null;
  return s;
}

export function parseResearchResponse(content: string): RaceResearchResult {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : content;
  const match = candidate.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Could not parse race research response");

  const d = JSON.parse(match[0]);

  const result: RaceResearchResult = {
    ...EMPTY_RESULT,
    raceName: toStr(d.raceName),
    location: toStr(d.location),
    swimEnvironment: toStr(d.swimEnvironment),
    waterTempC: toNum(d.waterTempC),
    wetsuitLikely:
      typeof d.wetsuitLikely === "boolean" ? d.wetsuitLikely : null,
    swimNotes: toStr(d.swimNotes),
    bikeElevationGainM: toNum(d.bikeElevationGainM),
    bikeCourseType: toStr(d.bikeCourseType),
    bikeNotes: toStr(d.bikeNotes),
    runElevationGainM: toNum(d.runElevationGainM),
    runCourseType: toStr(d.runCourseType),
    runSurface: toStr(d.runSurface),
    runNotes: toStr(d.runNotes),
    expectedTempC: toNum(d.expectedTempC),
    expectedHumidity: toNum(d.expectedHumidity),
    windNotes: toStr(d.windNotes),
    aiConfidence: ["high", "medium", "low"].includes(d.aiConfidence)
      ? d.aiConfidence
      : "low",
    unknownFields: Array.isArray(d.unknownFields) ? d.unknownFields.map(String) : [],
    questionsForAthlete: Array.isArray(d.questionsForAthlete)
      ? d.questionsForAthlete.map(String)
      : [],
    raceIdentified: d.raceIdentified === true,
    sources: Array.isArray(d.sources) ? d.sources.map(String) : [],
    usedWebSearch: false,
  };

  // Anything still null is, by definition, unknown — make sure it's listed.
  const checkable: Array<[keyof RaceResearchResult, string]> = [
    ["swimEnvironment", "Swim environment"],
    ["bikeElevationGainM", "Bike elevation gain"],
    ["runElevationGainM", "Run elevation gain"],
    ["expectedTempC", "Expected race-day temperature"],
  ];
  for (const [field, label] of checkable) {
    if (result[field] === null && !result.unknownFields.includes(label)) {
      result.unknownFields.push(label);
    }
  }

  if (result.questionsForAthlete.length === 0 && result.unknownFields.length > 0) {
    result.questionsForAthlete = FALLBACK_QUESTIONS;
  }

  return result;
}

const RESEARCH_SCHEMA = `{
  "raceName": string|null,
  "location": string|null,
  "swimEnvironment": "ocean"|"lake"|"river"|"pool"|null,
  "waterTempC": number|null,
  "wetsuitLikely": boolean|null,
  "swimNotes": string|null,
  "bikeElevationGainM": number|null,
  "bikeCourseType": "flat"|"rolling"|"hilly"|"mountainous"|null,
  "bikeNotes": string|null,
  "runElevationGainM": number|null,
  "runCourseType": "flat"|"rolling"|"hilly"|"mountainous"|null,
  "runSurface": "road"|"trail"|"mixed"|null,
  "runNotes": string|null,
  "expectedTempC": number|null,
  "expectedHumidity": number|null,
  "windNotes": string|null,
  "aiConfidence": "high"|"medium"|"low",
  "unknownFields": string[],
  "questionsForAthlete": string[],
  "raceIdentified": boolean,
  "sources": string[]
}`;

const HONESTY_RULES = `CRITICAL HONESTY RULES:
- Set "raceIdentified" to true ONLY if the sources clearly describe THIS EXACT race
  (the name and location must match). A different race in the same country does NOT count.
- If "raceIdentified" is false, set EVERY course field (swim, bike, run, climate) to null.
- Never substitute data from a similar or nearby race.
- Only state a value you can actually support. If unsure, use null.
- NEVER invent elevation figures, water temperatures or weather.
- List every field you could not determine in "unknownFields".
- Add clear questions for the athlete in "questionsForAthlete" for anything unknown.`;

/**
 * Researches the race using LIVE WEB SEARCH.
 *
 * Uses the Responses API with the built-in web_search tool, so the answers come
 * from current sources (official race pages, athlete guides, course databases)
 * rather than the model's memory. Every claim must carry a source URL.
 */
async function researchRaceWithWebSearch(input: {
  raceName?: string;
  location?: string;
  raceDate?: string;
  distanceType?: string;
}): Promise<RaceResearchResult> {
  const label = [input.raceName, input.location].filter(Boolean).join(", ");

  // --- Step 1: let the model search freely and answer in prose. ---
  // Forcing JSON in the same call makes it search less thoroughly, so we keep
  // the research step unconstrained and structure the answer afterwards.
  const research = await getOpenAI().responses.create({
    model: "gpt-4o-mini",
    tools: [{ type: "web_search" } as any],
    input: `Research the course profile of this triathlon: ${label}${
      input.distanceType ? ` (${input.distanceType})` : ""
    }${input.raceDate ? `, taking place ${input.raceDate}` : ""}.

Search official race pages, athlete guides and course databases and report:
1. Swim: ocean/sea, lake, river or pool? Typical water temperature. Are wetsuits usually legal?
2. Bike: TOTAL ELEVATION GAIN IN METRES, how hilly, and the major climbs.
3. Run: TOTAL ELEVATION GAIN IN METRES, how hilly, and the surface (road/trail/mixed).
4. Climate: typical temperature, humidity and wind at that place and time of year.

FIRST, state clearly whether you actually found THIS EXACT race (matching both name
and location). If you only found different races, say "RACE NOT FOUND" and stop —
do not describe a different event.

If found, give specific numbers wherever possible and cite the source for each.
If a specific detail cannot be found, say so explicitly.`,
  });

  const findings = (research as any).output_text as string | undefined;
  if (!findings) throw new Error("Empty web search response");

  // Collect the URLs the search tool actually cited.
  const urls = new Set<string>();
  try {
    for (const item of (research as any).output ?? []) {
      for (const c of item?.content ?? []) {
        for (const a of c?.annotations ?? []) {
          if (a?.url) urls.add(String(a.url).split("?utm_source=")[0]);
        }
      }
    }
  } catch {
    /* annotations are best-effort */
  }

  // --- Step 2: turn those findings into strict JSON. ---
  const structure = await getOpenAI().chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 1500,
    messages: [
      {
        role: "user",
        content: `Convert these research findings into JSON.

FINDINGS:
${findings}

${HONESTY_RULES}
- The race being asked about is: "${label}".
- If the findings say the race was not found, or describe a DIFFERENT event,
  set raceIdentified=false and every course field to null.
- Only fill a field if the findings actually support it. Do not infer numbers.
- Convert any imperial figures to metric.

Return ONLY the JSON object: ${RESEARCH_SCHEMA}`,
      },
    ],
  });

  const content = structure.choices[0].message.content;
  if (!content) throw new Error("Could not structure research findings");

  const result = parseResearchResponse(content);
  result.usedWebSearch = true;
  for (const u of result.sources) urls.add(u);
  result.sources = Array.from(urls);

  return result;
}

/** Fallback: the model's own knowledge, with no browsing. */
async function researchRaceFromMemory(input: {
  raceName?: string;
  location?: string;
  raceDate?: string;
  distanceType?: string;
}): Promise<RaceResearchResult> {
  const prompt = `You are a triathlon race analyst. Describe the demands of this race:

Race name: ${input.raceName || "(not given)"}
Location: ${input.location || "(not given)"}
Date: ${input.raceDate || "(not given)"}
Distance: ${input.distanceType || "(not given)"}

${HONESTY_RULES}
- You have NO internet access, so only use what you reliably know.
- Set aiConfidence to "high" only if you clearly recognise this exact event.

Return ONLY valid JSON: ${RESEARCH_SCHEMA}`;

  const response = await getOpenAI().chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 1500,
    messages: [{ role: "user", content: prompt }],
  });

  const content = response.choices[0].message.content;
  if (!content) throw new Error("No response from OpenAI");
  return parseResearchResponse(content);
}

/**
 * Hard safety net, enforced in code rather than trusted to the model:
 * if we did not positively identify the race, we discard EVERY course value
 * and ask the athlete instead. Better an empty box than a wrong number.
 */
export function enforceIdentification(
  result: RaceResearchResult,
  requestedName?: string
): RaceResearchResult {
  if (result.raceIdentified) return result;

  const cleared: RaceResearchResult = {
    ...result,
    raceName: result.raceName ?? requestedName ?? null,
    swimEnvironment: null,
    waterTempC: null,
    wetsuitLikely: null,
    swimNotes: null,
    bikeElevationGainM: null,
    bikeCourseType: null,
    bikeNotes: null,
    runElevationGainM: null,
    runCourseType: null,
    runSurface: null,
    runNotes: null,
    expectedTempC: null,
    expectedHumidity: null,
    windNotes: null,
    aiConfidence: "low",
    unknownFields: [
      "Swim environment",
      "Water temperature",
      "Bike elevation gain",
      "Bike course profile",
      "Run elevation gain",
      "Run course profile",
      "Expected race-day conditions",
    ],
    questionsForAthlete: FALLBACK_QUESTIONS,
  };
  return cleared;
}

/**
 * Researches a race. Tries live web search first and falls back to the model's
 * own knowledge if search is unavailable. Results are ALWAYS suggestions the
 * athlete must confirm.
 */
export async function researchRace(input: {
  raceName?: string;
  location?: string;
  raceDate?: string;
  distanceType?: string;
}): Promise<RaceResearchResult> {
  if (!input.raceName && !input.location) {
    return {
      ...EMPTY_RESULT,
      unknownFields: [
        "Swim environment",
        "Bike elevation gain",
        "Run elevation gain",
        "Expected race-day temperature",
      ],
      questionsForAthlete: FALLBACK_QUESTIONS,
    };
  }

  try {
    const viaWeb = await researchRaceWithWebSearch(input);
    return enforceIdentification(viaWeb, input.raceName);
  } catch (error) {
    console.error("Web search unavailable, falling back to model knowledge:", error);
    const fromMemory = await researchRaceFromMemory(input);
    return enforceIdentification(fromMemory, input.raceName);
  }
}

/** Renders the confirmed race demands for the AI coach's planning prompt. */
export function formatRaceProfileForPrompt(race: any): string {
  if (!race) return "";

  const lines: string[] = ["GOAL RACE DEMANDS:"];
  if (race.raceName) lines.push(`- Race: ${race.raceName}${race.location ? `, ${race.location}` : ""}`);
  if (race.distanceType) lines.push(`- Distance: ${race.distanceType}`);

  const swim: string[] = [];
  if (race.swimEnvironment) swim.push(`${race.swimEnvironment} swim`);
  if (race.waterTempC) swim.push(`water ~${race.waterTempC}°C`);
  if (race.wetsuitLikely !== null && race.wetsuitLikely !== undefined)
    swim.push(race.wetsuitLikely ? "wetsuit likely legal" : "wetsuit likely banned");
  if (swim.length) lines.push(`- Swim: ${swim.join(", ")}.${race.swimNotes ? ` ${race.swimNotes}` : ""}`);

  const bike: string[] = [];
  if (race.bikeCourseType) bike.push(`${race.bikeCourseType} course`);
  if (race.bikeElevationGainM) bike.push(`${race.bikeElevationGainM} m elevation gain`);
  if (bike.length) lines.push(`- Bike: ${bike.join(", ")}.${race.bikeNotes ? ` ${race.bikeNotes}` : ""}`);

  const run: string[] = [];
  if (race.runCourseType) run.push(`${race.runCourseType} course`);
  if (race.runElevationGainM) run.push(`${race.runElevationGainM} m elevation gain`);
  if (race.runSurface) run.push(`${race.runSurface} surface`);
  if (run.length) lines.push(`- Run: ${run.join(", ")}.${race.runNotes ? ` ${race.runNotes}` : ""}`);

  const climate: string[] = [];
  if (race.expectedTempC) climate.push(`~${race.expectedTempC}°C`);
  if (race.expectedHumidity) climate.push(`${race.expectedHumidity}% humidity`);
  if (race.windNotes) climate.push(race.windNotes);
  if (climate.length) lines.push(`- Conditions: ${climate.join(", ")}.`);

  lines.push(
    "Tailor the plan to these demands: include open-water skills and wetsuit practice if the swim is open water, hill and sustained-climb work matching the elevation profile, heat acclimatisation if hot, and race-specific brick sessions."
  );

  return lines.join("\n");
}

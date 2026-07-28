import { OpenAI } from "openai";
import { mondayOfWeek } from "./plan-dates";

/**
 * Created lazily so importing this module (e.g. from tests or from routes that
 * only need the date helpers) does not require an API key to be present.
 */
let client: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!client) {
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return client;
}

export interface AthleteProfileInput {
  age?: number;
  gender?: string;
  raceDate?: string;
  raceType?: string;
  pastPerformance?: string;
  timezone?: string;
}

export interface WeekOutline {
  week: number;
  phase: string;
  focus: string;
  targetHours: number;
  targetTss: number;
  isRaceWeek: boolean;
}

/** How many weeks separate today's Monday from race week (inclusive). */
export function weeksUntilRace(raceDate: Date, from: Date = new Date()): number {
  const start = mondayOfWeek(from);
  const raceWeekMonday = mondayOfWeek(raceDate);
  const diffDays = Math.round(
    (raceWeekMonday.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)
  );
  return Math.max(1, Math.floor(diffDays / 7) + 1);
}

function extractJson(content: string): any {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : content;
  const match = candidate.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Could not parse AI response as JSON");
  return JSON.parse(match[0]);
}

/**
 * STEP 1 — The macrocycle.
 * Produces a high-level outline for EVERY week between now and race day, so
 * the athlete can always see the shape of their season even before individual
 * sessions exist.
 */
export async function generateMacrocycle(
  profile: AthleteProfileInput,
  totalWeeks: number,
  trainingHistory?: string
): Promise<WeekOutline[]> {
  const prompt = `You are an expert triathlon coach building a season plan.

Athlete: ${profile.age || "age-group"} year old ${profile.gender?.toLowerCase() || "athlete"}.
Goal race: ${profile.raceType || "Olympic"} distance triathlon on ${profile.raceDate}.
Weeks available (including race week): ${totalWeeks}.
${profile.pastPerformance ? `Background: ${profile.pastPerformance}` : ""}
${trainingHistory ? `\n${trainingHistory}\n` : ""}

Produce a periodised outline covering ALL ${totalWeeks} weeks — do not skip any week.
Use sensible triathlon periodisation (Base → Build → Peak → Taper → Race), include
recovery/deload weeks roughly every 3rd-4th week, and make the final week the race week.

Ground the target hours in the athlete's demonstrated weekly volume. Progress
gradually (no more than ~10% jumps) and reduce volume on recovery and taper weeks.

Return ONLY valid JSON in exactly this shape:
{
  "outline": [
    {
      "week": 1,
      "phase": "Base",
      "focus": "Aerobic foundation, technique work",
      "targetHours": 7.5,
      "targetTss": 380,
      "isRaceWeek": false
    }
  ]
}
Every week from 1 to ${totalWeeks} must appear exactly once. Phase must be one of:
Base, Build, Peak, Taper, Race, Recovery.`;

  const response = await getOpenAI().chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 4000,
    messages: [{ role: "user", content: prompt }],
  });

  const content = response.choices[0].message.content;
  if (!content) throw new Error("No response from OpenAI");

  const data = extractJson(content);
  const outline: WeekOutline[] = (data.outline || []).map((w: any) => ({
    week: Number(w.week),
    phase: String(w.phase || "Base"),
    focus: String(w.focus || ""),
    targetHours: Number(w.targetHours) || 0,
    targetTss: Math.round(Number(w.targetTss) || 0),
    isRaceWeek: Boolean(w.isRaceWeek),
  }));

  // Guarantee complete, gap-free coverage even if the model missed a week.
  const byWeek = new Map(outline.map((w) => [w.week, w]));
  const complete: WeekOutline[] = [];
  for (let i = 1; i <= totalWeeks; i++) {
    complete.push(
      byWeek.get(i) ?? {
        week: i,
        phase: i === totalWeeks ? "Race" : "Base",
        focus: "",
        targetHours: 0,
        targetTss: 0,
        isRaceWeek: i === totalWeeks,
      }
    );
  }
  // The last week is always race week.
  complete[complete.length - 1].isRaceWeek = true;
  if (complete[complete.length - 1].phase !== "Race") {
    complete[complete.length - 1].phase = "Race";
  }

  return complete;
}

/**
 * STEP 2 — Detailed sessions.
 * Fills in day-by-day workouts for a specific set of weeks, guided by the
 * targets the macrocycle set for those same weeks.
 */
export async function generateDetailedWeeks(
  profile: AthleteProfileInput,
  weeksToDetail: WeekOutline[],
  trainingHistory?: string
) {
  const target = weeksToDetail;
  if (target.length === 0) return [];

  const targetsText = target
    .map(
      (w) =>
        `Week ${w.week}: phase ${w.phase}, focus "${w.focus}", target ${w.targetHours} h / ${w.targetTss} TSS`
    )
    .join("\n");

  const prompt = `You are an expert triathlon coach writing detailed workouts.

Athlete: ${profile.age || "age-group"} year old ${profile.gender?.toLowerCase() || "athlete"}.
Goal race: ${profile.raceType || "Olympic"} distance triathlon on ${profile.raceDate}.
${profile.pastPerformance ? `Background: ${profile.pastPerformance}` : ""}
${trainingHistory ? `\n${trainingHistory}\n` : ""}

Write full daily sessions for these weeks, respecting each week's targets:
${targetsText}

Rules:
- Each week must have 7 entries, one per day (Monday..Sunday). Use discipline "Rest" for rest days.
- The sum of each week's TSS should be close to that week's target TSS.
- Include swim, bike, run and at least one brick or strength session per week where appropriate.
- Instructions must be specific and actionable (warm-up, main set with intervals and rest, cool-down).
- Give concrete pace/effort guidance (zones, per-100m, per-km, or watts).

Return ONLY valid JSON in exactly this shape:
{
  "plan": [
    {
      "week": 1,
      "phase": "Base",
      "summary": "Aerobic base with technique focus",
      "sessions": [
        {
          "day": "Monday",
          "discipline": "Swim",
          "type": "Endurance",
          "duration": "45 min",
          "tss": 45,
          "instructions": "Warm-up 300m easy. Main: 10x100m steady, 20s rest. Cool-down 200m.",
          "pace": "1:45-1:50 per 100m"
        }
      ]
    }
  ]
}`;

  const response = await getOpenAI().chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 8000,
    messages: [{ role: "user", content: prompt }],
  });

  const content = response.choices[0].message.content;
  if (!content) throw new Error("No response from OpenAI");

  const data = extractJson(content);
  return data.plan || [];
}

/** Splits weeks into batches so long seasons don't blow the model's limits. */
export function chunkWeeks(
  weeks: WeekOutline[],
  batchSize = 4
): WeekOutline[][] {
  const batches: WeekOutline[][] = [];
  for (let i = 0; i < weeks.length; i += batchSize) {
    batches.push(weeks.slice(i, i + batchSize));
  }
  return batches;
}

/**
 * Generates detailed sessions for many weeks by making several smaller AI
 * calls. Writing 20+ weeks in one request produces truncated, low-quality
 * output, so we work in batches of a few weeks at a time.
 */
export async function generateDetailedWeeksBatched(
  profile: AthleteProfileInput,
  weeksToDetail: WeekOutline[],
  trainingHistory?: string,
  batchSize = 4
) {
  const batches = chunkWeeks(weeksToDetail, batchSize);
  const all: any[] = [];

  for (const batch of batches) {
    const result = await generateDetailedWeeks(profile, batch, trainingHistory);
    all.push(...result);
  }

  return all;
}

/**
 * Full generation: a complete season outline plus detailed sessions.
 *
 * `detailWeeks` controls how many weeks get day-by-day workouts.
 * Pass "all" to detail the entire season through to race day.
 */
export async function generateTrainingPlan(
  profile: AthleteProfileInput,
  trainingHistory?: string,
  options: { detailWeeks?: number | "all" } = {}
) {
  const raceDate = profile.raceDate
    ? new Date(profile.raceDate)
    : new Date(Date.now() + 16 * 7 * 24 * 60 * 60 * 1000);

  const totalWeeks = weeksUntilRace(raceDate);

  const requested = options.detailWeeks ?? 4;
  const detailWeeks =
    requested === "all" ? totalWeeks : Math.min(requested, totalWeeks);

  const outline = await generateMacrocycle(profile, totalWeeks, trainingHistory);
  const weeks = await generateDetailedWeeksBatched(
    profile,
    outline.slice(0, detailWeeks),
    trainingHistory
  );

  return { outline, weeks, totalWeeks, detailWeeks };
}

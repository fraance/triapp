/**
 * Builds the complete athlete picture that gets injected into every AI
 * coaching prompt: who they are, what they can do, what gear they have,
 * what the race demands, and what still needs testing.
 */
import { prisma } from "./prisma";
import { deriveAthleteMetrics, formatPace } from "./athlete-metrics";
import { analyseGaps, formatTestsForPrompt } from "./baseline-tests";
import { formatRaceProfileForPrompt } from "./race-profile";
import { detectPersonalBests, formatTime } from "./personal-bests";
import { getTrainingBudget, formatBudgetForPrompt } from "./availability";

function fmtDuration(seconds?: number | null): string | null {
  if (!seconds) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

/** The full athlete profile rendered as prompt text. */
export async function buildAthleteContext(userId: string): Promise<string> {
  const [profile, race] = await Promise.all([
    prisma.athleteProfile.findUnique({ where: { userId } }),
    prisma.raceProfile.findUnique({ where: { userId } }),
  ]);

  const metrics = await deriveAthleteMetrics(userId);
  const gaps = analyseGaps(metrics, profile as any);

  const sections: string[] = [];

  // --- Who they are ---
  const who: string[] = ["ATHLETE PROFILE:"];
  if (profile?.age) who.push(`- Age ${profile.age}${profile.gender ? `, ${profile.gender.toLowerCase()}` : ""}`);
  if (profile?.heightCm) who.push(`- Height ${profile.heightCm} cm`);
  if (profile?.weightKg) who.push(`- Weight ${profile.weightKg} kg`);
  if (profile?.bodyFatPct) who.push(`- Body fat ${profile.bodyFatPct}%`);

  if (profile?.favouriteSport) who.push(`- Favourite discipline: ${profile.favouriteSport}`);
  if (profile?.leastFavouriteSport)
    who.push(`- Least favourite discipline: ${profile.leastFavouriteSport} — keep these sessions engaging and achievable to protect consistency.`);
  if (who.length > 1) sections.push(who.join("\n"));

  // --- Time available vs physical capacity ---
  try {
    const budget = await getTrainingBudget(userId);
    sections.push(formatBudgetForPrompt(budget));
  } catch (e) {
    console.error("Could not build training budget:", e);
  }

  // --- Health ---
  const health: string[] = ["HEALTH & INJURY:"];
  if (profile?.injuryHistory) health.push(`- Injury history: ${profile.injuryHistory}`);
  if (profile?.ongoingIssues) health.push(`- Ongoing issues: ${profile.ongoingIssues}`);
  if (profile?.chronicConditions) health.push(`- Chronic conditions: ${profile.chronicConditions}`);
  if (profile?.mobilityLimitations) health.push(`- Mobility limitations: ${profile.mobilityLimitations}`);
  if (profile?.tracksMenstrualCycle) {
    health.push(
      `- Tracks menstrual cycle${profile.cycleLengthDays ? ` (~${profile.cycleLengthDays} day cycle)` : ""}. Where sensible, place higher-intensity work in the follicular phase and prioritise recovery in the late luteal/menstrual phase.`
    );
  }
  if (health.length > 1) {
    health.push("Respect these constraints — never prescribe work that risks aggravating a known injury.");
    sections.push(health.join("\n"));
  }

  // --- Performance numbers ---
  const perf: string[] = ["CURRENT PERFORMANCE MARKERS:"];
  const add = (label: string, m: { value: number | null; source: string; basis?: string }, format?: (v: number) => string) => {
    if (m.value === null) return;
    const shown = format ? format(m.value) : String(m.value);
    const tag = m.source === "measured" ? "confirmed" : "estimated";
    perf.push(`- ${label}: ${shown} (${tag}${m.basis ? ` — ${m.basis}` : ""})`);
  };

  add("Max heart rate", metrics.maxHeartRate, (v) => `${v} bpm`);
  add("Resting heart rate", metrics.restingHeartRate, (v) => `${v} bpm`);
  add("Cycling FTP", metrics.ftpWatts, (v) => `${v} W`);
  add("Power-to-weight", metrics.ftpPerKg, (v) => `${v} W/kg`);
  add("Bike threshold HR", metrics.bikeLthr, (v) => `${v} bpm`);
  add("Run threshold pace", metrics.runThresholdPaceSec, (v) => `${formatPace(v)}/km`);
  add("Run threshold HR", metrics.runLthr, (v) => `${v} bpm`);
  add("Critical Swim Speed", metrics.swimCssSecPer100, (v) => `${formatPace(v)}/100m`);
  add("Recent weekly volume", metrics.weeklyHours, (v) => `${v} h/week`);

  if (profile?.swimStrokeCount) perf.push(`- Swim stroke count: ${profile.swimStrokeCount} per length`);
  if (profile?.swimStrokeRate) perf.push(`- Swim stroke rate: ${profile.swimStrokeRate} spm`);
  if (profile?.runCadence) perf.push(`- Run cadence: ${profile.runCadence} spm`);

  // Personal bests: prefer what the athlete confirmed, otherwise what we
  // detected in their Strava history.
  const detectedPbs = await detectPersonalBests(userId).catch(() => []);
  const pbMap = new Map(detectedPbs.map((p) => [p.key, p]));
  const pbEntries: string[] = [];
  for (const [key, label] of [
    ["pb5kSec", "5k"],
    ["pb10kSec", "10k"],
    ["pbHalfSec", "Half"],
    ["pbMarathonSec", "Marathon"],
  ] as const) {
    const stored = profile?.[key as keyof typeof profile] as number | undefined;
    const found = pbMap.get(key as any);
    if (stored) {
      pbEntries.push(`${label} ${fmtDuration(stored)}`);
    } else if (found) {
      pbEntries.push(
        `${label} ${formatTime(found.seconds)} (from Strava, ${found.date})`
      );
    }
  }
  if (pbEntries.length) perf.push(`- Run personal bests: ${pbEntries.join(", ")}`);

  if (perf.length > 1) {
    perf.push(
      'Use CONFIRMED numbers to set precise training zones. Where a number is only "estimated", pace that work conservatively and by feel until a test confirms it.'
    );
    sections.push(perf.join("\n"));
  }

  // --- Equipment ---
  const eq = metrics.equipment;
  const owned = [
    eq.powerMeter && "power meter",
    eq.heartRateMonitor && "heart-rate monitor",
    eq.gpsWatch && "GPS watch",
    eq.smartTrainer && "indoor trainer",
    eq.swimTracking && "swim tracking",
  ].filter(Boolean);

  const equipmentLines = ["EQUIPMENT AVAILABLE (detected from their data):"];
  equipmentLines.push(owned.length ? `- Has: ${owned.join(", ")}` : "- No training hardware detected");
  if (!eq.powerMeter)
    equipmentLines.push("- No power meter: prescribe bike sessions using heart rate, cadence and perceived effort, NOT watts.");
  if (!eq.heartRateMonitor)
    equipmentLines.push("- No heart-rate monitor: prescribe everything by perceived effort and pace.");
  if (!eq.swimTracking)
    equipmentLines.push("- No swim tracking: give swim sets in distance and clock time, not device metrics.");
  sections.push(equipmentLines.join("\n"));

  // --- Race demands ---
  const raceText = formatRaceProfileForPrompt(race);
  if (raceText) sections.push(raceText);

  // --- Baseline tests ---
  const testText = formatTestsForPrompt(gaps.recommendedTests);
  if (testText) sections.push(testText);

  return sections.join("\n\n");
}

/** Structured summary for the UI (what we know, what's missing). */
export async function getAthleteSnapshot(userId: string) {
  const [profile, race] = await Promise.all([
    prisma.athleteProfile.findUnique({ where: { userId } }),
    prisma.raceProfile.findUnique({ where: { userId } }),
  ]);
  const metrics = await deriveAthleteMetrics(userId);
  const gaps = analyseGaps(metrics, profile as any);

  return { profile, race, metrics, gaps };
}

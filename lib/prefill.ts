/**
 * Prefill engine.
 *
 * Project rule: never ask the athlete for something we can already work out.
 *
 * This walks every data source we hold and fills in blank profile fields,
 * recording where each value came from. It NEVER overwrites something the
 * athlete typed themselves — it only fills gaps (or improves an objectively
 * worse value, such as a slower personal best).
 */
import { prisma } from "./prisma";
import { fetchAthlete, mapStravaSex } from "./strava";
import { getValidAccessToken } from "./strava-db";
import { deriveAthleteMetrics } from "./athlete-metrics";
import { detectPersonalBests, formatTime } from "./personal-bests";

export interface PrefillEntry {
  field: string;
  label: string;
  value: number | string;
  display: string;
  origin: string; // where it came from, in plain English
}

/** A disagreement between what the athlete entered and what we found. */
export interface PrefillConflict {
  field: string;
  label: string;
  currentValue: number | string;
  currentDisplay: string;
  suggestedValue: number | string;
  suggestedDisplay: string;
  origin: string;
}

export interface PrefillResult {
  applied: PrefillEntry[];
  /** Differences awaiting the athlete's decision. */
  conflicts: PrefillConflict[];
  /** Fields already set that matched what we found (nothing to do). */
  confirmed: string[];
  errors: string[];
}

/**
 * How far a found value may differ from the athlete's before we bother them.
 * Keeps trivial differences from becoming noise.
 */
export const CONFLICT_TOLERANCE: Record<string, number> = {
  weightKg: 1, // kg
  heightCm: 1,
  bodyFatPct: 1,
  maxHeartRate: 3, // bpm
  restingHeartRate: 3,
  bikeMaxHr: 3,
  runMaxHr: 3,
  bikeLthr: 3,
  runLthr: 3,
  ftpWatts: 5, // watts
  runThresholdPaceSec: 5, // seconds per km
  swimCssSecPer100: 5,
  weeklyHoursAvailable: 1, // hours
  pb5kSec: 2, // seconds
  pb10kSec: 2,
  pbHalfSec: 5,
  pbMarathonSec: 10,
};

/** True when a stored value counts as "not provided". */
function isBlank(v: unknown): boolean {
  return v === null || v === undefined || v === "";
}

/** True when the two values differ enough to be worth asking about. */
export function isMeaningfulDifference(
  field: string,
  current: unknown,
  suggested: unknown
): boolean {
  if (isBlank(current) || isBlank(suggested)) return false;

  if (typeof current === "number" && typeof suggested === "number") {
    const tolerance = CONFLICT_TOLERANCE[field] ?? 0;
    return Math.abs(current - suggested) > tolerance;
  }

  return String(current).trim().toLowerCase() !== String(suggested).trim().toLowerCase();
}

/**
 * Fills every blank field we can from Strava's athlete profile, the athlete's
 * activity history, and their detected personal bests.
 */
export async function prefillAthleteProfile(
  userId: string
): Promise<PrefillResult> {
  const applied: PrefillEntry[] = [];
  const conflicts: PrefillConflict[] = [];
  const confirmed: string[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  const profile = await prisma.athleteProfile.findUnique({ where: { userId } });
  const updates: Record<string, any> = {};

  /**
   * Fills a blank field, or — when the athlete already has a different value —
   * records a conflict for them to decide on. Never overwrites silently.
   */
  const fill = (
    field: string,
    label: string,
    value: number | string | null | undefined,
    origin: string,
    display?: string,
    currentDisplay?: (v: any) => string
  ) => {
    if (isBlank(value)) return;

    // A higher-priority source already handled this field in this run
    // (Strava's stored profile beats our own estimates).
    if (seen.has(field)) return;

    const current = profile ? (profile as any)[field] : null;
    const shown = display ?? String(value);

    if (isBlank(current)) {
      seen.add(field);
      updates[field] = value;
      applied.push({
        field,
        label,
        value: value as number | string,
        display: shown,
        origin,
      });
      return;
    }

    seen.add(field);

    // The athlete has a value. Only bother them if ours genuinely differs.
    if (!isMeaningfulDifference(field, current, value)) {
      confirmed.push(label);
      return;
    }

    conflicts.push({
      field,
      label,
      currentValue: current,
      currentDisplay: currentDisplay ? currentDisplay(current) : String(current),
      suggestedValue: value as number | string,
      suggestedDisplay: shown,
      origin,
    });
  };

  // ---- Source 1: the athlete's own Strava profile ------------------------
  let stravaCity: string | null = null;
  let stravaCountry: string | null = null;
  try {
    const token = await getValidAccessToken(userId);
    if (token) {
      const athlete = await fetchAthlete(token);
      stravaCity = athlete.city ?? null;
      stravaCountry = athlete.country ?? null;

      fill("weightKg", "Body weight", athlete.weight ?? null, "Your Strava profile", `${athlete.weight} kg`);
      fill("ftpWatts", "Cycling FTP", athlete.ftp ?? null, "Your Strava profile", `${athlete.ftp} W`);
      fill("gender", "Sex", mapStravaSex(athlete.sex), "Your Strava profile");

      // Gear tells us what equipment they own.
      if (athlete.bikes?.length) {
        const names = athlete.bikes.map((b) => b.name).join(", ");
        fill("gearNotes" as any, "Bikes", names, "Your Strava gear");
      }
    }
  } catch (e: any) {
    errors.push(`Strava profile: ${e?.message ?? "unavailable"}`);
  }

  // ---- Source 2: metrics derived from activity history -------------------
  try {
    const metrics = await deriveAthleteMetrics(userId);

    /**
     * What the athlete's data says for this metric, regardless of whether they
     * have typed their own value. Used to detect disagreements.
     */
    const fromData = (m: { value: number | null; source: string; dataValue?: number | null }) =>
      m.source === "measured" ? (m.dataValue ?? null) : m.value;

    {
      const v = fromData(metrics.maxHeartRate);
      if (v) fill("maxHeartRate", "Max heart rate", v, metrics.maxHeartRate.dataBasis ?? metrics.maxHeartRate.basis ?? "Your activity history", `${v} bpm`);
    }
    {
      const v = fromData(metrics.ftpWatts);
      if (v) fill("ftpWatts", "Cycling FTP", v, metrics.ftpWatts.dataBasis ?? "Estimated from your rides", `${v} W`);
    }
    {
      const v = fromData(metrics.runThresholdPaceSec);
      if (v) fill("runThresholdPaceSec", "Run threshold pace", v, metrics.runThresholdPaceSec.dataBasis ?? "Estimated from your runs", `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}/km`, (c) => `${Math.floor(Number(c) / 60)}:${String(Number(c) % 60).padStart(2, "0")}/km`);
    }
    {
      const v = fromData(metrics.swimCssSecPer100);
      if (v) fill("swimCssSecPer100", "Critical Swim Speed", v, metrics.swimCssSecPer100.dataBasis ?? "Estimated from your swims", `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}/100m`, (c) => `${Math.floor(Number(c) / 60)}:${String(Number(c) % 60).padStart(2, "0")}/100m`);
    }
    {
      const v = fromData(metrics.bikeLthr);
      if (v) fill("bikeLthr", "Bike threshold HR", v, "Estimated from your bike heart rates", `${v} bpm`);
    }
    {
      const v = fromData(metrics.runLthr);
      if (v) fill("runLthr", "Run threshold HR", v, "Estimated from your run heart rates", `${v} bpm`);
    }
    {
      const v = fromData(metrics.bikeMaxHr);
      if (v) fill("bikeMaxHr", "Max HR on bike", v, "Highest HR recorded cycling", `${v} bpm`);
    }
    {
      const v = fromData(metrics.runMaxHr);
      if (v) fill("runMaxHr", "Max HR on run", v, "Highest HR recorded running", `${v} bpm`);
    }
    // Their realistic weekly availability starts from what they actually do.
    if (metrics.weeklyHours.value) {
      fill("weeklyHoursAvailable", "Weekly hours available", metrics.weeklyHours.value, metrics.weeklyHours.basis ?? "Your recent training volume", `${metrics.weeklyHours.value} h/week`);
    }
  } catch (e: any) {
    errors.push(`Activity metrics: ${e?.message ?? "unavailable"}`);
  }

  // ---- Source 3: personal bests ------------------------------------------
  try {
    const pbs = await detectPersonalBests(userId);
    for (const pb of pbs) {
      fill(
        pb.key,
        pb.label,
        pb.seconds,
        pb.precision === "official"
          ? `Official Strava split, ${pb.date}`
          : `Your run on ${pb.date}`,
        formatTime(pb.seconds),
        (v) => formatTime(Number(v))
      );
    }
  } catch (e: any) {
    errors.push(`Personal bests: ${e?.message ?? "unavailable"}`);
  }

  // `gearNotes` isn't a real column — drop it before writing.
  delete updates.gearNotes;

  if (Object.keys(updates).length > 0) {
    await prisma.athleteProfile.upsert({
      where: { userId },
      create: { userId, ...updates },
      update: updates,
    });
  }

  // ---- Source 4: race location from the athlete's home city --------------
  try {
    if (stravaCity) {
      const race = await prisma.raceProfile.findUnique({ where: { userId } });
      if (race && isBlank(race.location)) {
        const location = [stravaCity, stravaCountry].filter(Boolean).join(", ");
        await prisma.raceProfile.update({
          where: { userId },
          data: { location },
        });
        applied.push({
          field: "location",
          label: "Race location",
          value: location,
          display: location,
          origin: "Your Strava home city",
        });
      }
    }
  } catch (e: any) {
    errors.push(`Race location: ${e?.message ?? "unavailable"}`);
  }

  // Record conflicts so the athlete can decide, and so we remember their answer.
  try {
    await persistSuggestions(userId, conflicts);
  } catch (e: any) {
    errors.push(`Saving suggestions: ${e?.message ?? "failed"}`);
  }

  // Only surface conflicts the athlete hasn't already answered.
  const pending = await prisma.profileSuggestion.findMany({
    where: { userId, status: "pending" },
  });
  const pendingFields = new Set(pending.map((p) => p.field));

  return {
    applied,
    conflicts: conflicts.filter((c) => pendingFields.has(c.field)),
    confirmed,
    errors,
  };
}

/**
 * Stores each conflict as a pending question for the athlete.
 *
 * If they previously dismissed a suggestion we stay quiet, unless what we found
 * has since changed — in which case it's genuinely new information.
 */
async function persistSuggestions(
  userId: string,
  conflicts: PrefillConflict[]
): Promise<void> {
  for (const c of conflicts) {
    const existing = await prisma.profileSuggestion.findUnique({
      where: { userId_field: { userId, field: c.field } },
    });

    const suggestedValue = String(c.suggestedValue);

    // Already answered, and our finding hasn't changed → don't nag.
    if (
      existing &&
      existing.status !== "pending" &&
      existing.suggestedValue === suggestedValue
    ) {
      continue;
    }

    const data = {
      label: c.label,
      valueType: typeof c.suggestedValue === "number" ? "number" : "string",
      currentValue: String(c.currentValue),
      currentDisplay: c.currentDisplay,
      suggestedValue,
      suggestedDisplay: c.suggestedDisplay,
      origin: c.origin,
      status: "pending",
    };

    await prisma.profileSuggestion.upsert({
      where: { userId_field: { userId, field: c.field } },
      create: { userId, field: c.field, ...data },
      update: data,
    });
  }
}

/** The questions currently waiting for the athlete. */
export async function getPendingSuggestions(userId: string) {
  return prisma.profileSuggestion.findMany({
    where: { userId, status: "pending" },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Applies the athlete's decision.
 * "accept" writes our value onto their profile; "dismiss" keeps theirs.
 */
export async function resolveSuggestion(
  userId: string,
  field: string,
  decision: "accept" | "dismiss"
): Promise<{ resolved: boolean; applied?: string }> {
  const suggestion = await prisma.profileSuggestion.findUnique({
    where: { userId_field: { userId, field } },
  });
  if (!suggestion) return { resolved: false };

  if (decision === "accept") {
    const value =
      suggestion.valueType === "number"
        ? Number(suggestion.suggestedValue)
        : suggestion.suggestedValue;

    await prisma.athleteProfile.upsert({
      where: { userId },
      create: { userId, [field]: value } as any,
      update: { [field]: value } as any,
    });
  }

  await prisma.profileSuggestion.update({
    where: { userId_field: { userId, field } },
    data: { status: decision === "accept" ? "accepted" : "dismissed" },
  });

  return {
    resolved: true,
    applied: decision === "accept" ? suggestion.suggestedDisplay : undefined,
  };
}

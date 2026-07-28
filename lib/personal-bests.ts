/**
 * Run personal bests, pulled automatically from Strava.
 *
 * Two levels of accuracy:
 *
 *  1. QUICK — from the activity list we already hold. If a run's total distance
 *     is close to a standard race distance, its time is a candidate PB. Free,
 *     instant, but only catches runs that were actually that distance.
 *
 *  2. OFFICIAL — Strava calculates "best efforts" inside every run (the fastest
 *     5 km contained in a 10 km run, etc.). These live on the DETAILED activity
 *     endpoint, one API call per activity, so we fetch them in rate-limited
 *     batches and cache the results.
 */
import { prisma } from "./prisma";
import { STRAVA_API_BASE } from "./strava";
import { getValidAccessToken } from "./strava-db";

export interface PbDefinition {
  key: "pb5kSec" | "pb10kSec" | "pbHalfSec" | "pbMarathonSec";
  label: string;
  metres: number;
  /** Names Strava uses for this distance in best_efforts. */
  stravaNames: string[];
  /** How far off the exact distance a run can be and still count. */
  tolerance: number;
}

export const PB_DISTANCES: PbDefinition[] = [
  { key: "pb5kSec", label: "5 km", metres: 5000, stravaNames: ["5k"], tolerance: 0.03 },
  { key: "pb10kSec", label: "10 km", metres: 10000, stravaNames: ["10k"], tolerance: 0.03 },
  {
    key: "pbHalfSec",
    label: "Half marathon",
    metres: 21097,
    stravaNames: ["half-marathon", "half marathon"],
    tolerance: 0.02,
  },
  {
    key: "pbMarathonSec",
    label: "Marathon",
    metres: 42195,
    stravaNames: ["marathon"],
    tolerance: 0.02,
  },
];

export interface DetectedPb {
  key: PbDefinition["key"];
  label: string;
  seconds: number;
  date: string;
  activityName: string;
  /** "official" = Strava's own split; "activity" = whole-run time. */
  precision: "official" | "activity";
}

export function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

/** Matches a Strava best-effort name to one of our tracked distances. */
export function matchPbDistance(name: string): PbDefinition | null {
  const n = (name || "").trim().toLowerCase();
  return (
    PB_DISTANCES.find((d) => d.stravaNames.some((s) => s === n)) ?? null
  );
}

/**
 * Finds the best time for each distance, preferring Strava's official splits
 * and falling back to whole-activity times.
 */
export async function detectPersonalBests(
  userId: string
): Promise<DetectedPb[]> {
  const [efforts, runs] = await Promise.all([
    prisma.stravaBestEffort.findMany({
      where: { userId },
      orderBy: { elapsedTime: "asc" },
      include: { activity: { select: { name: true } } },
    }),
    prisma.stravaActivity.findMany({
      where: { userId, discipline: "Run" },
      orderBy: { startDate: "desc" },
    }),
  ]);

  const best = new Map<string, DetectedPb>();

  // --- Official Strava splits take priority ---
  for (const e of efforts) {
    const def = matchPbDistance(e.name);
    if (!def) continue;
    const existing = best.get(def.key);
    if (!existing || e.elapsedTime < existing.seconds) {
      best.set(def.key, {
        key: def.key,
        label: def.label,
        seconds: e.elapsedTime,
        date: e.startDate.toISOString().split("T")[0],
        activityName: e.activity?.name ?? "",
        precision: "official",
      });
    }
  }

  // --- Fall back to whole-run times for anything still missing ---
  for (const def of PB_DISTANCES) {
    if (best.has(def.key)) continue;

    const candidates = runs.filter((r) => {
      if (!r.distance || !r.movingTime) return false;
      const diff = Math.abs(r.distance - def.metres) / def.metres;
      // Must be at least the distance, and not much longer.
      return r.distance >= def.metres * 0.99 && diff <= def.tolerance;
    });

    if (candidates.length === 0) continue;

    const fastest = candidates.reduce((a, b) =>
      a.movingTime <= b.movingTime ? a : b
    );
    best.set(def.key, {
      key: def.key,
      label: def.label,
      seconds: fastest.movingTime,
      date: fastest.startDate.toISOString().split("T")[0],
      activityName: fastest.name,
      precision: "activity",
    });
  }

  return PB_DISTANCES.map((d) => best.get(d.key)).filter(
    (p): p is DetectedPb => Boolean(p)
  );
}

interface RawBestEffort {
  name: string;
  distance: number;
  elapsed_time: number;
  moving_time?: number;
  start_date_local?: string;
  start_date?: string;
}

/** Fetches one detailed activity so we can read its official best efforts. */
export async function fetchActivityDetail(
  accessToken: string,
  stravaId: string
): Promise<{ best_efforts?: RawBestEffort[] } | null> {
  const res = await fetch(`${STRAVA_API_BASE}/activities/${stravaId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 404) return null;
  if (res.status === 429) throw new Error("Strava rate limit reached — try again later");
  if (!res.ok) {
    throw new Error(`Strava activity detail failed (${res.status})`);
  }
  return res.json();
}

/**
 * Pulls official best efforts for runs we haven't detailed yet.
 *
 * Strava allows 100 requests per 15 minutes, so we work in small batches,
 * newest and longest runs first (those contain the most useful splits).
 */
export async function enrichBestEfforts(
  userId: string,
  opts: { limit?: number } = {}
): Promise<{ processed: number; effortsStored: number; remaining: number }> {
  const limit = opts.limit ?? 25;

  const accessToken = await getValidAccessToken(userId);
  if (!accessToken) throw new Error("Strava is not connected for this user");

  // Only runs long enough to contain a standard distance are worth detailing.
  const pending = await prisma.stravaActivity.findMany({
    where: {
      userId,
      discipline: "Run",
      detailsFetched: false,
      distance: { gte: 4800 },
    },
    orderBy: [{ distance: "desc" }, { startDate: "desc" }],
    take: limit,
  });

  let processed = 0;
  let effortsStored = 0;

  for (const activity of pending) {
    let detail: { best_efforts?: RawBestEffort[] } | null = null;
    try {
      detail = await fetchActivityDetail(accessToken, activity.stravaId);
    } catch (error: any) {
      // Stop cleanly on rate limiting rather than hammering the API.
      if (/rate limit/i.test(error?.message || "")) break;
      console.error(`Could not fetch activity ${activity.stravaId}:`, error?.message);
      continue;
    }

    processed++;

    for (const effort of detail?.best_efforts ?? []) {
      if (!matchPbDistance(effort.name)) continue;
      const when = effort.start_date_local || effort.start_date;
      try {
        await prisma.stravaBestEffort.upsert({
          where: {
            activityId_name: { activityId: activity.id, name: effort.name },
          },
          create: {
            activityId: activity.id,
            userId,
            name: effort.name,
            distance: effort.distance,
            elapsedTime: effort.elapsed_time,
            movingTime: effort.moving_time ?? null,
            startDate: when ? new Date(when) : activity.startDate,
          },
          update: {
            elapsedTime: effort.elapsed_time,
            movingTime: effort.moving_time ?? null,
          },
        });
        effortsStored++;
      } catch (e) {
        console.error("Could not store best effort:", e);
      }
    }

    await prisma.stravaActivity.update({
      where: { id: activity.id },
      data: { detailsFetched: true },
    });
  }

  const remaining = await prisma.stravaActivity.count({
    where: { userId, discipline: "Run", detailsFetched: false, distance: { gte: 4800 } },
  });

  return { processed, effortsStored, remaining };
}

/**
 * Writes detected personal bests onto the athlete profile.
 *
 * Only fills BLANK fields. If the athlete already recorded a time that differs
 * from what we found, we leave it alone — the prefill engine raises that as a
 * suggestion for them to decide on, rather than overwriting silently.
 */
export async function applyPersonalBestsToProfile(
  userId: string
): Promise<{ updated: string[] }> {
  const detected = await detectPersonalBests(userId);
  if (detected.length === 0) return { updated: [] };

  const profile = await prisma.athleteProfile.findUnique({ where: { userId } });
  const data: Record<string, number> = {};
  const updated: string[] = [];

  for (const pb of detected) {
    const current = profile ? (profile as any)[pb.key] : null;
    if (current === null || current === undefined) {
      data[pb.key] = pb.seconds;
      updated.push(`${pb.label} ${formatTime(pb.seconds)}`);
    }
  }

  if (Object.keys(data).length > 0) {
    await prisma.athleteProfile.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
  }

  return { updated };
}

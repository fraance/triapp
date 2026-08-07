import { prisma } from "./prisma";
import {
  refreshAccessToken,
  normaliseActivity,
  fetchActivities,
  fetchAllActivities,
  estimateTss,
  type RawStravaActivity,
  type TssContext,
} from "./strava";

// ---- Athlete load context (thresholds) ----------------------------------

/**
 * Works out the athlete's TSS context: their threshold HR, max HR and how hard
 * each discipline feels for them.
 *
 * Priority: what the athlete told us > what their own Strava data shows >
 * generic defaults. Using the athlete's OBSERVED max HR instead of a generic
 * 190 bpm makes the load numbers far more representative.
 */
export async function getTssContext(userId: string): Promise<TssContext> {
  const profile = await prisma.athleteProfile.findUnique({ where: { userId } });

  let maxHeartRate = profile?.maxHeartRate ?? null;

  // Derive max HR from their real activities when not provided.
  if (!maxHeartRate) {
    const observed = await prisma.stravaActivity.aggregate({
      where: { userId, maxHeartRate: { not: null } },
      _max: { maxHeartRate: true },
    });
    if (observed._max.maxHeartRate) {
      maxHeartRate = Math.round(observed._max.maxHeartRate);
    }
  }

  const thresholdHeartRate =
    profile?.thresholdHeartRate ??
    (maxHeartRate ? Math.round(maxHeartRate * 0.9) : null);

  return {
    maxHeartRate,
    thresholdHeartRate,
    difficulty: {
      Swim: profile?.swimDifficulty ?? 1,
      Bike: profile?.bikeDifficulty ?? 1,
      Run: profile?.runDifficulty ?? 1,
      Strength: 1,
      Other: 1,
    },
  };
}

/**
 * Recalculates the stored training load for every activity, e.g. after the
 * athlete updates their thresholds or difficulty settings.
 */
export async function recalculateAllTss(userId: string): Promise<number> {
  const context = await getTssContext(userId);
  const activities = await prisma.stravaActivity.findMany({ where: { userId } });

  let updated = 0;
  for (const a of activities) {
    const tss = estimateTss(
      {
        movingTime: a.movingTime,
        discipline: a.discipline,
        avgHeartRate: a.avgHeartRate,
        maxHeartRate: a.maxHeartRate,
        sufferScore: a.sufferScore,
      },
      context
    );
    if (tss !== a.estimatedTss) {
      await prisma.stravaActivity.update({
        where: { id: a.id },
        data: { estimatedTss: tss },
      });
      updated++;
    }
  }
  return updated;
}

// ---- Token storage ------------------------------------------------------

export async function saveStravaToken(
  userId: string,
  data: {
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
    athleteId?: string;
    athleteName?: string;
    scope?: string;
  }
) {
  return prisma.stravaToken.upsert({
    where: { userId },
    create: { userId, ...data },
    update: data,
  });
}

export async function getStravaToken(userId: string) {
  return prisma.stravaToken.findUnique({ where: { userId } });
}

export async function disconnectStrava(userId: string) {
  await prisma.stravaToken.deleteMany({ where: { userId } });
}

/**
 * Returns a valid access token for the user, refreshing it if it has expired
 * (or is about to). Returns null if the user has not connected Strava.
 */
export async function getValidAccessToken(
  userId: string
): Promise<string | null> {
  const token = await getStravaToken(userId);
  if (!token) return null;

  // Refresh if expiring within the next 5 minutes.
  const expiresSoon = token.expiresAt.getTime() - Date.now() < 5 * 60 * 1000;
  if (!expiresSoon) return token.accessToken;

  const refreshed = await refreshAccessToken(token.refreshToken);
  await saveStravaToken(userId, {
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token,
    expiresAt: new Date(refreshed.expires_at * 1000),
    athleteId: token.athleteId ?? undefined,
    athleteName: token.athleteName ?? undefined,
    scope: token.scope ?? undefined,
  });
  return refreshed.access_token;
}

// ---- Activity storage ---------------------------------------------------

/**
 * Stores activities, skipping any we already have (matched on Strava's own id).
 * Returns how many were newly added vs. already known.
 */
export async function storeActivities(
  userId: string,
  rawActivities: RawStravaActivity[]
): Promise<{ added: number; skipped: number }> {
  let added = 0;
  let skipped = 0;

  // Load the athlete's thresholds once so every activity is scored consistently.
  const context = await getTssContext(userId);

  for (const raw of rawActivities) {
    const activity = normaliseActivity(raw, context);
    const existing = await prisma.stravaActivity.findUnique({
      where: { userId_stravaId: { userId, stravaId: activity.stravaId } },
    });

    if (existing) {
      skipped++;
      continue;
    }

    await prisma.stravaActivity.create({ data: { userId, ...activity } });
    added++;
  }

  return { added, skipped };
}

/**
 * Pulls activities from Strava and saves them.
 * By default it walks the athlete's ENTIRE history, not just the first page.
 */
export async function syncStravaActivities(
  userId: string,
  opts: { after?: Date; full?: boolean } = {}
) {
  const accessToken = await getValidAccessToken(userId);
  if (!accessToken) {
    throw new Error("Strava is not connected for this user");
  }

  const raw =
    opts.full === false
      ? await fetchActivities(accessToken, { perPage: 200, after: opts.after })
      : await fetchAllActivities(accessToken, { after: opts.after });

  const result = await storeActivities(userId, raw);

  // Max HR may have moved after importing more history — rescore everything
  // so old and new activities are measured on the same scale.
  const rescored = await recalculateAllTss(userId);

  return { fetched: raw.length, ...result, rescored };
}

export async function getActivities(userId: string, limit = 50) {
  return prisma.stravaActivity.findMany({
    where: { userId },
    orderBy: { startDate: "desc" },
    take: limit,
  });
}

export async function getActivityCount(userId: string) {
  return prisma.stravaActivity.count({ where: { userId } });
}

// ---- Scheduled background sync -----------------------------------------

export interface UserSyncResult {
  userId: string;
  email?: string;
  ok: boolean;
  fetched?: number;
  added?: number;
  skipped?: number;
  error?: string;
}

/**
 * Incremental sync for one athlete: only asks Strava for activities since a
 * little before the newest one we already hold. This keeps the daily job fast
 * and well within Strava's rate limits, while still catching activities that
 * were uploaded late.
 */
export async function syncUserIncremental(userId: string): Promise<UserSyncResult> {
  try {
    const newest = await prisma.stravaActivity.findFirst({
      where: { userId },
      orderBy: { startDate: "desc" },
      select: { startDate: true },
    });

    // 3-day overlap so late uploads/edits are still picked up.
    const after = newest
      ? new Date(newest.startDate.getTime() - 3 * 24 * 60 * 60 * 1000)
      : undefined;

    const result = await syncStravaActivities(userId, {
      after,
      full: after ? false : true, // first ever sync pulls everything
    });

    // Pull official best-effort splits for any new runs, then refresh PBs.
    try {
      const { enrichBestEfforts, applyPersonalBestsToProfile } = await import(
        "./personal-bests"
      );
      await enrichBestEfforts(userId, { limit: 15 });
      await applyPersonalBestsToProfile(userId);
      // Keep the profile topped up from every source we hold.
      const { prefillAthleteProfile } = await import("./prefill");
      await prefillAthleteProfile(userId);
    } catch (e) {
      console.error("Best-effort enrichment skipped:", e);
    }

    await prisma.stravaToken.updateMany({
      where: { userId },
      data: { lastSyncedAt: new Date(), lastSyncError: null },
    });

    return {
      userId,
      ok: true,
      fetched: result.fetched,
      added: result.added,
      skipped: result.skipped,
    };
  } catch (error: any) {
    const message = error?.message || "Unknown error";
    await prisma.stravaToken
      .updateMany({
        where: { userId },
        data: { lastSyncedAt: new Date(), lastSyncError: message },
      })
      .catch(() => {});
    return { userId, ok: false, error: message };
  }
}

/**
 * Runs the incremental sync for every athlete who has connected Strava.
 * This is what the daily background job calls.
 */
export async function syncAllConnectedUsers(
  opts: { userIds?: string[] } = {}
): Promise<{
  users: number;
  succeeded: number;
  failed: number;
  totalAdded: number;
  results: UserSyncResult[];
}> {
  // `userIds` lets callers (notably tests) restrict the job to specific
  // accounts so it can never touch unrelated real athletes' data.
  const tokens = await prisma.stravaToken.findMany({
    where: opts.userIds ? { userId: { in: opts.userIds } } : undefined,
    select: { userId: true, user: { select: { email: true } } },
  });

  const results: UserSyncResult[] = [];
  for (const token of tokens) {
    const result = await syncUserIncremental(token.userId);
    result.email = token.user?.email;
    results.push(result);
  }

  return {
    users: tokens.length,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    totalAdded: results.reduce((sum, r) => sum + (r.added ?? 0), 0),
    results,
  };
}

// ---- Training history summary (context for the AI coach) ----------------

export interface TrainingHistorySummary {
  hasData: boolean;
  totalActivities: number;
  weeksAnalysed: number;
  avgWeeklyHours: number;
  avgWeeklyTss: number;
  maxHeartRate: number | null;
  thresholdHeartRate: number | null;
  byDiscipline: Array<{
    discipline: string;
    count: number;
    totalHours: number;
    totalDistanceKm: number;
    avgHeartRate: number | null;
    longestMinutes: number;
  }>;
  longestRideKm: number;
  longestRunKm: number;
  longestSwimKm: number;
  recentActivities: Array<{
    date: string;
    discipline: string;
    name: string;
    minutes: number;
    distanceKm: number;
    tss: number;
  }>;
}

/**
 * Builds a compact summary of the athlete's real training history so the AI
 * coach can ground its plan in what the athlete actually does, rather than
 * generic assumptions.
 */
export async function buildTrainingHistory(
  userId: string,
  daysBack = 90
): Promise<TrainingHistorySummary> {
  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);

  const context = await getTssContext(userId);

  const activities = await prisma.stravaActivity.findMany({
    where: { userId, startDate: { gte: since } },
    orderBy: { startDate: "desc" },
  });

  if (activities.length === 0) {
    return {
      hasData: false,
      totalActivities: 0,
      weeksAnalysed: 0,
      avgWeeklyHours: 0,
      avgWeeklyTss: 0,
      maxHeartRate: context.maxHeartRate ?? null,
      thresholdHeartRate: context.thresholdHeartRate ?? null,
      byDiscipline: [],
      longestRideKm: 0,
      longestRunKm: 0,
      longestSwimKm: 0,
      recentActivities: [],
    };
  }

  const weeks = Math.max(1, daysBack / 7);
  const totalSeconds = activities.reduce((s, a) => s + a.movingTime, 0);
  const totalTss = activities.reduce((s, a) => s + a.estimatedTss, 0);

  const disciplines = ["Swim", "Bike", "Run", "Strength", "Other"];
  const byDiscipline = disciplines
    .map((d) => {
      const items = activities.filter((a) => a.discipline === d);
      if (items.length === 0) return null;
      const hrValues = items
        .map((a) => a.avgHeartRate)
        .filter((h): h is number => typeof h === "number" && h > 0);
      return {
        discipline: d,
        count: items.length,
        totalHours:
          Math.round((items.reduce((s, a) => s + a.movingTime, 0) / 3600) * 10) / 10,
        totalDistanceKm:
          Math.round((items.reduce((s, a) => s + a.distance, 0) / 1000) * 10) / 10,
        avgHeartRate:
          hrValues.length > 0
            ? Math.round(hrValues.reduce((s, h) => s + h, 0) / hrValues.length)
            : null,
        longestMinutes: Math.round(
          Math.max(...items.map((a) => a.movingTime)) / 60
        ),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  const longestOf = (discipline: string) => {
    const items = activities.filter((a) => a.discipline === discipline);
    if (items.length === 0) return 0;
    return Math.round((Math.max(...items.map((a) => a.distance)) / 1000) * 10) / 10;
  };

  return {
    hasData: true,
    totalActivities: activities.length,
    weeksAnalysed: Math.round(weeks),
    avgWeeklyHours: Math.round((totalSeconds / 3600 / weeks) * 10) / 10,
    avgWeeklyTss: Math.round(totalTss / weeks),
    maxHeartRate: context.maxHeartRate ?? null,
    thresholdHeartRate: context.thresholdHeartRate ?? null,
    byDiscipline,
    longestRideKm: longestOf("Bike"),
    longestRunKm: longestOf("Run"),
    longestSwimKm: longestOf("Swim"),
    recentActivities: activities.slice(0, 15).map((a) => ({
      date: a.startDate.toISOString().split("T")[0],
      discipline: a.discipline,
      name: a.name,
      minutes: Math.round(a.movingTime / 60),
      distanceKm: Math.round((a.distance / 1000) * 10) / 10,
      tss: a.estimatedTss,
    })),
  };
}

/** Renders the history summary as plain text for injection into the AI prompt. */
export function formatHistoryForPrompt(h: TrainingHistorySummary): string {
  if (!h.hasData) return "";

  const lines: string[] = [];
  lines.push(
    `REAL TRAINING HISTORY (last ${h.weeksAnalysed} weeks, imported from Strava):`
  );
  lines.push(
    `- ${h.totalActivities} activities; averaging ${h.avgWeeklyHours} h/week and ~${h.avgWeeklyTss} TSS/week.`
  );
  if (h.thresholdHeartRate) {
    lines.push(
      `- Threshold HR ~${h.thresholdHeartRate} bpm${h.maxHeartRate ? `, max HR ~${h.maxHeartRate} bpm` : ""}.`
    );
  }

  for (const d of h.byDiscipline) {
    const hr = d.avgHeartRate ? `, avg HR ${d.avgHeartRate}` : "";
    lines.push(
      `- ${d.discipline}: ${d.count} sessions, ${d.totalHours} h, ${d.totalDistanceKm} km, longest ${d.longestMinutes} min${hr}.`
    );
  }

  if (h.longestRideKm) lines.push(`- Longest ride: ${h.longestRideKm} km.`);
  if (h.longestRunKm) lines.push(`- Longest run: ${h.longestRunKm} km.`);
  if (h.longestSwimKm) lines.push(`- Longest swim: ${h.longestSwimKm} km.`);

  lines.push("Most recent sessions:");
  for (const a of h.recentActivities.slice(0, 10)) {
    lines.push(
      `  ${a.date} — ${a.discipline} "${a.name}" ${a.minutes} min, ${a.distanceKm} km, ~${a.tss} TSS`
    );
  }

  lines.push(
    "Use this real history to set realistic starting volume and intensity. Do not prescribe large jumps beyond the athlete's demonstrated capacity."
  );

  return lines.join("\n");
}

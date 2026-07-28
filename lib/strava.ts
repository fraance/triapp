/**
 * Strava integration — per-user OAuth, token refresh, and activity normalisation.
 *
 * Unlike the previous version, every user has their own tokens stored in the
 * database. Nothing relies on a single global token from the environment.
 */

export const STRAVA_CLIENT_ID = process.env.STRAVA_CLIENT_ID || "";
export const STRAVA_CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET || "";
export const STRAVA_REDIRECT_URI =
  process.env.STRAVA_REDIRECT_URI ||
  "http://localhost:3000/api/strava/callback";

export const STRAVA_AUTH_URL = "https://www.strava.com/oauth/authorize";
export const STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token";
export const STRAVA_API_BASE = "https://www.strava.com/api/v3";

/** Scope needed to read all activities, including private ones. */
export const STRAVA_SCOPE = "read,activity:read_all,profile:read_all";

export function isStravaConfigured(): boolean {
  return Boolean(STRAVA_CLIENT_ID && STRAVA_CLIENT_SECRET);
}

/** Builds the URL we send the athlete to in order to grant access. */
export function buildAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: STRAVA_CLIENT_ID,
    redirect_uri: STRAVA_REDIRECT_URI,
    response_type: "code",
    approval_prompt: "auto",
    scope: STRAVA_SCOPE,
    state,
  });
  return `${STRAVA_AUTH_URL}?${params.toString()}`;
}

export interface StravaTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_at: number; // unix seconds
  scope?: string;
  athlete?: { id: number; firstname?: string; lastname?: string };
}

/** Exchanges the one-time OAuth code for access + refresh tokens. */
export async function exchangeCodeForToken(
  code: string
): Promise<StravaTokenResponse> {
  const res = await fetch(STRAVA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: STRAVA_CLIENT_ID,
      client_secret: STRAVA_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
    }),
  });

  if (!res.ok) {
    throw new Error(`Strava token exchange failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

/** Uses a stored refresh token to get a fresh access token. */
export async function refreshAccessToken(
  refreshToken: string
): Promise<StravaTokenResponse> {
  const res = await fetch(STRAVA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: STRAVA_CLIENT_ID,
      client_secret: STRAVA_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    throw new Error(`Strava token refresh failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

// ---- Activity normalisation --------------------------------------------

/** Maps Strava's many sport types onto our four training disciplines. */
export function normaliseDiscipline(sportType: string): string {
  const t = (sportType || "").toLowerCase();
  if (t.includes("swim")) return "Swim";
  if (
    t.includes("ride") ||
    t.includes("bike") ||
    t.includes("cycl") ||
    t.includes("handcycle") ||
    t.includes("velomobile")
  )
    return "Bike";
  // Walks and hikes are NOT running — counting them as runs distorts run
  // volume, pace estimates and personal bests.
  if (t.includes("walk") || t.includes("hike")) return "Other";
  if (t.includes("run")) return "Run";
  if (
    t.includes("weight") ||
    t.includes("workout") ||
    t.includes("crossfit") ||
    t.includes("strength")
  )
    return "Strength";
  return "Other";
}

/**
 * Estimates a training-load score (TSS-like) for an activity.
 *
 * A proper TSS needs the athlete's own thresholds. When we know them we use
 * heart-rate based TSS (the standard hrTSS approach):
 *
 *     IF   = average HR / threshold HR
 *     TSS  = hours x IF^2 x 100
 *
 * When heart rate is missing (common for swims and some rides) we fall back to
 * duration x a per-discipline intensity factor, which the athlete can tune
 * because disciplines genuinely feel different from person to person.
 */
export interface TssContext {
  /** The athlete's lactate-threshold HR. Falls back to 0.9 x max HR. */
  thresholdHeartRate?: number | null;
  /** The athlete's true max HR (measured or observed from their history). */
  maxHeartRate?: number | null;
  /** Per-discipline multipliers so the athlete can reflect what feels hard. */
  difficulty?: Partial<Record<string, number>>;
}

export function estimateTss(
  input: {
    movingTime: number; // seconds
    discipline: string;
    avgHeartRate?: number | null;
    maxHeartRate?: number | null;
    sufferScore?: number | null;
  },
  context: TssContext = {}
): number {
  const { movingTime, discipline, avgHeartRate } = input;

  const hours = Math.max(0, movingTime) / 3600;
  if (hours === 0) return 0;

  const difficulty =
    context.difficulty?.[discipline] ??
    context.difficulty?.[discipline.toLowerCase()] ??
    1;

  // --- Preferred path: heart-rate based TSS using the athlete's threshold ---
  if (avgHeartRate && avgHeartRate > 0) {
    // Threshold HR: explicit > derived from max HR > derived from this activity.
    const maxHr =
      context.maxHeartRate ||
      input.maxHeartRate ||
      null;
    const thresholdHr =
      context.thresholdHeartRate ||
      (maxHr ? Math.round(maxHr * 0.9) : null) ||
      170; // last-resort reference

    const intensity = Math.min(1.2, Math.max(0.35, avgHeartRate / thresholdHr));
    return Math.round(hours * intensity * intensity * 100 * difficulty);
  }

  // --- Fallback: Strava's relative effort, if present ---
  if (input.sufferScore && input.sufferScore > 0) {
    return Math.round(input.sufferScore * difficulty);
  }

  // --- Fallback: duration x typical intensity for the discipline ---
  const baseline: Record<string, number> = {
    Swim: 0.78,
    Bike: 0.75,
    Run: 0.85,
    Strength: 0.55,
    Other: 0.65,
  };
  const intensity = baseline[discipline] ?? 0.65;
  return Math.round(hours * intensity * intensity * 100 * difficulty);
}

export interface RawStravaActivity {
  id: number | string;
  name: string;
  type?: string;
  sport_type?: string;
  start_date: string;
  moving_time: number;
  elapsed_time?: number;
  distance: number;
  total_elevation_gain?: number;
  average_heartrate?: number;
  max_heartrate?: number;
  average_speed?: number;
  average_watts?: number;
  suffer_score?: number;
  trainer?: boolean;
}

/** Converts a raw Strava activity into the shape we store. */
export function normaliseActivity(raw: RawStravaActivity, context: TssContext = {}) {
  const sportType = raw.sport_type || raw.type || "Unknown";
  const discipline = normaliseDiscipline(sportType);
  return {
    stravaId: String(raw.id),
    name: raw.name || "Untitled activity",
    sportType,
    discipline,
    startDate: new Date(raw.start_date),
    movingTime: raw.moving_time ?? 0,
    elapsedTime: raw.elapsed_time ?? null,
    distance: raw.distance ?? 0,
    elevationGain: raw.total_elevation_gain ?? null,
    avgHeartRate: raw.average_heartrate ?? null,
    maxHeartRate: raw.max_heartrate ?? null,
    avgSpeed: raw.average_speed ?? null,
    avgWatts: raw.average_watts ?? null,
    sufferScore: raw.suffer_score ?? null,
    estimatedTss: estimateTss(
      {
        movingTime: raw.moving_time ?? 0,
        discipline,
        avgHeartRate: raw.average_heartrate,
        maxHeartRate: raw.max_heartrate,
        sufferScore: raw.suffer_score,
      },
      context
    ),
    isTrainer: Boolean(raw.trainer),
  };
}

/** Fetches a single page of the athlete's activities. */
export async function fetchActivities(
  accessToken: string,
  opts: { perPage?: number; page?: number; after?: Date } = {}
): Promise<RawStravaActivity[]> {
  const params = new URLSearchParams({
    per_page: String(opts.perPage ?? 100),
    page: String(opts.page ?? 1),
  });
  if (opts.after) {
    params.set("after", String(Math.floor(opts.after.getTime() / 1000)));
  }

  const res = await fetch(`${STRAVA_API_BASE}/athlete/activities?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    throw new Error(`Strava activities fetch failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

/**
 * Walks through ALL pages of the athlete's activity history.
 * Strava returns at most 200 per page, so a full history needs several calls.
 */
export async function fetchAllActivities(
  accessToken: string,
  opts: { after?: Date; maxPages?: number; perPage?: number } = {}
): Promise<RawStravaActivity[]> {
  const perPage = opts.perPage ?? 200;
  const maxPages = opts.maxPages ?? 20; // up to 4000 activities
  const all: RawStravaActivity[] = [];

  for (let page = 1; page <= maxPages; page++) {
    const batch = await fetchActivities(accessToken, {
      perPage,
      page,
      after: opts.after,
    });
    all.push(...batch);
    if (batch.length < perPage) break; // last page reached
  }

  return all;
}

// ---- Athlete profile ----------------------------------------------------

export interface RawStravaAthlete {
  id: number;
  firstname?: string;
  lastname?: string;
  sex?: "M" | "F" | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  weight?: number | null; // kilograms
  ftp?: number | null; // watts
  bikes?: Array<{ id: string; name: string; primary?: boolean }>;
  shoes?: Array<{ id: string; name: string; primary?: boolean }>;
}

/**
 * Reads the athlete's own Strava profile. This is a rich prefill source:
 * Strava already stores their weight, FTP, sex, home city and gear.
 */
export async function fetchAthlete(accessToken: string): Promise<RawStravaAthlete> {
  const res = await fetch(`${STRAVA_API_BASE}/athlete`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Strava athlete fetch failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

/** Maps Strava's single-letter sex field to the wording we use. */
export function mapStravaSex(sex?: string | null): string | null {
  if (sex === "F") return "Female";
  if (sex === "M") return "Male";
  return null;
}

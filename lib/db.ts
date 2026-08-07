import { prisma } from "./prisma";
import bcrypt from "bcryptjs";
import {
  mondayOfWeek,
  sessionDate,
  isSameDay,
  startOfDay,
  weekNumberFor,
  daysBetween,
  addDays,
  planWeekOneMonday,
} from "./plan-dates";
import { freezeBoundary } from "./reschedule";
import { hideGhosts, hidePastNonEvents, didTrain } from "./session-status";
import { loadVectorFor } from "./adaptation/load-vector";

// User functions
export async function createUser(email: string, password: string) {
  const hashedPassword = await bcrypt.hash(password, 10);
  return prisma.user.create({
    data: {
      email,
      password: hashedPassword,
      profile: {
        create: {},
      },
    },
    include: { profile: true },
  });
}

export async function getUserByEmail(email: string) {
  return prisma.user.findUnique({
    where: { email },
    include: { profile: true },
  });
}

export async function verifyPassword(password: string, hashedPassword: string) {
  return bcrypt.compare(password, hashedPassword);
}

// Profile functions

/**
 * Updates only the fields actually provided. Any key that is `undefined` is
 * left untouched, so a partial save can never wipe settings the athlete
 * entered earlier (e.g. their heart-rate thresholds).
 *
 * Uses upsert so a profile is created if it somehow doesn't exist yet.
 */
export async function updateProfile(userId: string, data: Record<string, any>) {
  const clean: Record<string, any> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) clean[key] = value;
  }

  return prisma.athleteProfile.upsert({
    where: { userId },
    create: { userId, ...clean },
    update: clean,
  });
}

export async function getProfile(userId: string) {
  return prisma.athleteProfile.findUnique({
    where: { userId },
  });
}

// Training plan functions
export async function createTrainingPlan(
  userId: string,
  targetRaceDate: Date,
  weekCount: number
) {
  return prisma.trainingPlan.create({
    data: {
      userId,
      targetRaceDate,
      weekCount,
    },
  });
}

export async function getTrainingPlan(planId: string) {
  return prisma.trainingPlan.findUnique({
    where: { id: planId },
    include: { sessions: { orderBy: [{ week: "asc" }, { day: "asc" }] } },
  });
}

export async function getUserLatestPlan(userId: string) {
  return prisma.trainingPlan.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: { sessions: { orderBy: [{ week: "asc" }, { day: "asc" }] } },
  });
}

// Planned session functions
export async function createPlannedSessions(
  planId: string,
  sessions: Array<{
    week: number;
    phase?: string;
    summary?: string;
    day: string;
    discipline: string;
    type: string;
    duration: string;
    tss: number;
    instructions?: string;
    pace?: string;
  }>
) {
  return prisma.plannedSession.createMany({
    data: sessions.map((session) => ({
      planId,
      ...session,
    })),
  });
}

// ---- Full training plan persistence (weeks structure from the AI coach) ----

export interface PlanSession {
  day: string;
  discipline: string;
  type: string;
  duration: string;
  tss: number;
  instructions?: string;
  pace?: string;
}

export interface PlanWeek {
  week: number;
  phase?: string;
  summary?: string;
  sessions: PlanSession[];
}

/**
 * Collapses duplicate sessions that would land on the same calendar day in the
 * same discipline and type.
 *
 * A plan must never prescribe the same session twice. Every write path calls
 * `sessionDate(planStart, week, day)` to place a session, so if the AI happens
 * to emit two identical rows (same week + day + discipline + type) they become
 * two identical sessions on one date — which reads as "Monday swim, and also
 * another Monday swim", exactly the kind of day/type that stops matching what
 * the athlete actually did. We keep only the first of each group. Distinct
 * sessions on the same day (e.g. the two halves of a brick) are left intact.
 */
function collapseDayDuplicates<T extends { week: number; day: string; discipline: string; type: string }>(
  rows: T[]
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    const key = `${r.week}|${r.day}|${r.discipline}|${r.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/**
 * Persists a full generated plan (array of weeks) for a user.
 * Replaces any previous plan so "latest" is the single source of truth.
 */
export async function saveFullPlan(
  userId: string,
  targetRaceDate: Date,
  weeks: PlanWeek[],
  startDate?: Date,
  outline?: Array<{
    week: number;
    phase: string;
    focus?: string;
    targetHours?: number;
    targetTss?: number;
    isRaceWeek?: boolean;
  }>
) {
  // Remove old plans for this user so the newest generation is authoritative.
  //
  // ⚠️ This DESTROYS every past session and its history. Only acceptable when
  // the athlete has no plan yet, or has explicitly asked to start over.
  // Rebuilding an existing plan must use `rebuildFutureSessions`, which keeps
  // what has already happened — training the athlete has actually done is
  // evidence, not a draft.
  await prisma.trainingPlan.deleteMany({ where: { userId } });

  const currentPhase = outline?.[0]?.phase ?? weeks[0]?.phase ?? null;

  // Week 1 always begins on the Monday of the week the plan starts.
  const planStart = mondayOfWeek(startDate ?? new Date());

  // The plan spans the full macrocycle when we have one.
  const weekCount = outline?.length ?? weeks.length;

  const plan = await prisma.trainingPlan.create({
    data: {
      userId,
      targetRaceDate,
      startDate: planStart,
      currentPhase,
      weekCount,
      detailedWeeks: weeks.length,
    },
  });

  if (outline && outline.length > 0) {
    await prisma.planWeekOutline.createMany({
      data: outline.map((w) => ({
        planId: plan.id,
        week: w.week,
        phase: w.phase,
        focus: w.focus ?? null,
        targetHours: w.targetHours ?? null,
        targetTss: w.targetTss ?? null,
        isRaceWeek: Boolean(w.isRaceWeek),
      })),
    });
  }

  const flatSessions = weeks.flatMap((week) =>
    week.sessions.map((s) => {
      // Sessions must be born with a real calendar date. Without it the
      // adaptation engine, which queries by scheduledDate, cannot see a
      // freshly generated plan at all and reports the athlete has none.
      const date = sessionDate(planStart, week.week, s.day);
      return {
        planId: plan.id,
        week: week.week,
        phase: week.phase ?? null,
        summary: week.summary ?? null,
        day: s.day,
        scheduledDate: date,
        originalDate: date,
        discipline: s.discipline,
        type: s.type,
        duration: s.duration,
        tss: typeof s.tss === "number" ? s.tss : parseInt(String(s.tss)) || 0,
        originalTss: typeof s.tss === "number" ? s.tss : parseInt(String(s.tss)) || 0,
        instructions: s.instructions ?? null,
        pace: s.pace ?? null,
      };
    })
  );

  const deduped = collapseDayDuplicates(flatSessions);
  if (deduped.length > 0) {
    await prisma.plannedSession.createMany({ data: deduped });
  }

  return plan;
}

/**
 * Rebuilds the remaining plan while leaving the past alone.
 *
 * A regeneration used to delete the athlete's plan outright and anchor the new
 * week 1 to the current Monday, so a week they had just trained stopped being
 * part of their plan and its history went with it. What they have actually done
 * is the one thing in here that cannot be regenerated.
 *
 * So: the plan record and its start date survive, sessions on or after
 * `fromDate` are replaced, and everything before it is untouched.
 */
export async function rebuildFutureSessions(
  userId: string,
  weeks: PlanWeek[],
  outline: Array<{
    week: number;
    phase: string;
    focus?: string;
    targetHours?: number;
    targetTss?: number;
    isRaceWeek?: boolean;
  }>,
  fromDate: Date
) {
  const plan = await prisma.trainingPlan.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
  if (!plan) throw new Error("No plan to rebuild.");

  const planStart = plan.startDate ?? mondayOfWeek(plan.createdAt);
  const cutoff = startOfDay(fromDate);

  // Only the future goes.
  await prisma.plannedSession.deleteMany({
    where: { planId: plan.id, scheduledDate: { gte: cutoff } },
  });

  const kept = await prisma.plannedSession.count({ where: { planId: plan.id } });

  const flat = weeks.flatMap((week) =>
    week.sessions
      .map((s) => {
        const date = sessionDate(planStart, week.week, s.day);
        if (!date || date < cutoff) return null; // the past is not rewritten
        const tss = typeof s.tss === "number" ? s.tss : parseInt(String(s.tss)) || 0;
        return {
          planId: plan.id,
          week: week.week,
          phase: week.phase ?? null,
          summary: week.summary ?? null,
          day: s.day,
          scheduledDate: date,
          originalDate: date,
          discipline: s.discipline,
          type: s.type,
          duration: s.duration,
          tss,
          originalTss: tss,
          instructions: s.instructions ?? null,
          pace: s.pace ?? null,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
  );

  if (flat.length > 0) {
    await prisma.plannedSession.createMany({ data: collapseDayDuplicates(flat) });
  }

  // Week outlines are safe to replace wholesale: they carry no history.
  if (outline.length > 0) {
    await prisma.planWeekOutline.deleteMany({ where: { planId: plan.id } });
    await prisma.planWeekOutline.createMany({
      data: outline.map((w) => ({
        planId: plan.id,
        week: w.week,
        phase: w.phase,
        focus: w.focus ?? null,
        targetHours: w.targetHours ?? null,
        targetTss: w.targetTss ?? null,
        isRaceWeek: Boolean(w.isRaceWeek),
      })),
    });
  }

  await prisma.trainingPlan.update({
    where: { id: plan.id },
    data: {
      weekCount: Math.max(plan.weekCount, outline.length),
      detailedWeeks: weeks.length,
      currentPhase: outline[0]?.phase ?? plan.currentPhase,
    },
  });

  return { planId: plan.id, kept, written: flat.length };
}

/**
 * Loads the user's latest plan and reconstructs it into the weeks structure
 * the dashboard/profile UI expects.
 */
export async function getUserLatestPlanAsWeeks(
  userId: string
): Promise<PlanWeek[] | null> {
  const plan = await prisma.trainingPlan.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: { sessions: { orderBy: [{ week: "asc" }, { id: "asc" }] } },
  });

  if (!plan || plan.sessions.length === 0) return null;

  const weekMap = new Map<number, PlanWeek>();
  for (const s of plan.sessions) {
    if (!weekMap.has(s.week)) {
      weekMap.set(s.week, {
        week: s.week,
        phase: s.phase ?? undefined,
        summary: s.summary ?? undefined,
        sessions: [],
      });
    }
    weekMap.get(s.week)!.sessions.push({
      day: s.day,
      discipline: s.discipline,
      type: s.type,
      duration: s.duration,
      tss: s.tss,
      instructions: s.instructions ?? "",
      pace: s.pace ?? "",
    });
  }

  return Array.from(weekMap.values()).sort((a, b) => a.week - b.week);
}

export async function updateSessionStatus(
  sessionId: string,
  status: string,
  actualTss?: number,
  completedAt?: Date
) {
  return prisma.plannedSession.update({
    where: { id: sessionId },
    data: {
      status,
      actualTss,
      completedAt,
    },
  });
}

/**
 * Lets the athlete correct what a session that already happened actually was
 * — Strava can see duration and effort, but has no idea a prescribed 6x3
 * became a 3x3. Only a session they actually trained (`didTrain`) can be
 * corrected; nothing else has a "what actually happened" to revise.
 *
 * When the session is evidenced by a Strava activity, the correction is also
 * written back onto that activity's `estimatedTss`. Every load calculation
 * the engine runs — chronic/acute EWMA, ramp budgets, the coach's physiology
 * read — reads `stravaActivity` directly, never the plan row, so leaving the
 * two numbers to disagree would mean the correction never reached the
 * algorithm the athlete is trying to inform.
 */
export async function updateExecutedSession(
  sessionId: string,
  edit: {
    actualTss?: number | null;
    athleteNote?: string | null;
    type?: string | null;
    duration?: string | null;
    difficulty?: string | null;
    bodyNote?: string | null;
  }
) {
  const session = await prisma.plannedSession.findUnique({ where: { id: sessionId } });
  if (!session) throw new Error("Session not found");
  if (!didTrain(session.status)) {
    throw new Error(
      "Only a session the athlete actually trained can be corrected"
    );
  }

  const data: {
    actualTss?: number;
    athleteNote?: string | null;
    type?: string;
    duration?: string;
    difficulty?: string | null;
    bodyNote?: string | null;
  } = {};
  if (edit.actualTss !== undefined && edit.actualTss !== null) {
    if (!Number.isFinite(edit.actualTss) || edit.actualTss < 0) {
      throw new Error("actualTss must be a non-negative number");
    }
    data.actualTss = Math.round(edit.actualTss);
  }
  if (edit.athleteNote !== undefined) {
    data.athleteNote = edit.athleteNote ? edit.athleteNote.trim().slice(0, 500) || null : null;
  }
  if (edit.type !== undefined) {
    data.type = edit.type ? edit.type.trim().slice(0, 80) : undefined;
  }
  if (edit.duration !== undefined) {
    const cleaned = edit.duration ? edit.duration.trim().slice(0, 40) : "";
    if (!cleaned) {
      throw new Error("Enter a duration");
    }
    data.duration = cleaned;
  }
  if (edit.difficulty !== undefined) {
    data.difficulty = edit.difficulty
      ? edit.difficulty.trim().slice(0, 40) || null
      : null;
  }
  if (edit.bodyNote !== undefined) {
    data.bodyNote = edit.bodyNote ? edit.bodyNote.trim().slice(0, 500) || null : null;
  }

  const updated = await prisma.plannedSession.update({
    where: { id: sessionId },
    data,
  });

  if (data.actualTss !== undefined && session.sourceActivityId) {
    await prisma.stravaActivity
      .update({
        where: { id: session.sourceActivityId },
        data: { estimatedTss: data.actualTss },
      })
      .catch(() => {
        // The activity may have been removed independently (a Strava
        // deletion, a disconnect); the plan-side correction still stands.
      });
  }

  return updated;
}

// ---- "Today" view -------------------------------------------------------

export interface DaySession {
  id: string;
  discipline: string;
  type: string;
  duration: string;
  /** Prescribed load. Zero on unplanned training, which was never prescribed. */
  tss: number;
  /** What it actually cost, once reconciled against Strava. */
  actualTss: number | null;
  /** The Strava activity that evidences this, when it is marked as done. */
  evidence: string | null;
  instructions: string;
  pace: string;
  status: string;
  day: string;
  week: number;
  date: string; // YYYY-MM-DD
  /** The athlete's own correction to what actually happened, if they gave one. */
  athleteNote: string | null;
}

export interface TodayView {
  date: string; // YYYY-MM-DD for the requested day
  hasPlan: boolean;
  inPlanRange: boolean;
  week: number | null;
  phase: string | null;
  summary: string | null;
  sessions: DaySession[];
  tomorrow: DaySession[];
  weekTssPlanned: number;
  weekTssCompleted: number;
  daysUntilRace: number | null;
  raceDate: string | null;
}

function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * What a session's "type" should read to the athlete.
 *
 * Reconciliation gives training with nothing on the plan the placeholder
 * type "Unplanned" (see `reconcile.ts`) so the database always knows how it
 * got there. Showing that word back to the athlete reads as the app not
 * knowing what they did — it does not matter to them whether a session was
 * planned or not, only that it happened, so the executed activity's own name
 * (e.g. "Evening Ride") is shown instead whenever we have it.
 */
function displayTypeFor(
  session: { type: string; sourceActivityId: string | null },
  evidence: Map<string, { name: string }>
): string {
  if (session.type !== "Unplanned") return session.type;
  const activity = session.sourceActivityId ? evidence.get(session.sourceActivityId) : null;
  return activity?.name || "Done";
}

/**
 * Builds everything the "Today" screen needs for a given user and day.
 * `referenceDate` defaults to now (injectable so tests are deterministic).
 */
export async function getTodayView(
  userId: string,
  referenceDate: Date = new Date()
): Promise<TodayView> {
  const today = startOfDay(referenceDate);
  const tomorrow = startOfDay(new Date(today.getTime() + 24 * 60 * 60 * 1000));

  const plan = await prisma.trainingPlan.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: { sessions: { orderBy: [{ week: "asc" }, { id: "asc" }] } },
  });

  const empty: TodayView = {
    date: toISODate(today),
    hasPlan: false,
    inPlanRange: false,
    week: null,
    phase: null,
    summary: null,
    sessions: [],
    tomorrow: [],
    weekTssPlanned: 0,
    weekTssCompleted: 0,
    daysUntilRace: null,
    raceDate: null,
  };

  if (!plan || plan.sessions.length === 0) return empty;

  const planStart = plan.startDate ?? plan.createdAt;

  // Only "Unplanned" rows ever need the evidence's real name (see
  // `displayTypeFor`), and only those carry a `sourceActivityId` — so this
  // stays a light query even on a long-running plan.
  const unplannedSourceIds = plan.sessions
    .filter((s) => s.type === "Unplanned" && s.sourceActivityId)
    .map((s) => s.sourceActivityId!);
  const evidence = new Map<string, { name: string }>();
  if (unplannedSourceIds.length > 0) {
    const activities = await prisma.stravaActivity.findMany({
      where: { id: { in: unplannedSourceIds } },
      select: { id: true, name: true },
    });
    for (const a of activities) evidence.set(a.id, a);
  }

  // Attach a real calendar date to every session.
  //
  // `scheduledDate` wins where it exists. It is what the adaptation engine and
  // manual rescheduling write, so trusting week/day instead would show the
  // athlete a session on the day it was originally written rather than the day
  // they actually moved it to.
  const dated = plan.sessions
    .map((s) => {
      const date = s.scheduledDate ?? sessionDate(planStart, s.week, s.day);
      return date ? { session: s, date } : null;
    })
    .filter((x): x is { session: (typeof plan.sessions)[number]; date: Date } => x !== null);

  const toDaySession = (item: { session: any; date: Date }): DaySession => ({
    id: item.session.id,
    discipline: item.session.discipline,
    type: displayTypeFor(item.session, evidence),
    duration: item.session.duration,
    tss: item.session.tss,
    actualTss: item.session.actualTss ?? null,
    evidence: item.session.sourceActivityId ?? null,
    instructions: item.session.instructions ?? "",
    pace: item.session.pace ?? "",
    status: item.session.status,
    day: item.session.day,
    week: weekNumberFor(planStart, item.date),
    date: toISODate(item.date),
    athleteNote: item.session.athleteNote ?? null,
  });

  /**
   * v3 §2.4, the Baseline Rule: the database keeps the planned session as a
   * ghost record so the engine never loses its intent-vs-reality baseline, but
   * the athlete should not be shown a session they did not do alongside the one
   * they did. Hidden in the UI only.
   *
   * The rule itself lives in `session-status.ts` so this screen and the
   * calendar cannot disagree about what "done" means — they already had.
   */
  const hideGhostItems = (items: typeof dated) => {
    const keep = new Set(
      hideGhosts(
        items.map((d) => ({
          id: d.session.id,
          status: d.session.status,
          date: toISODate(d.date),
        }))
      ).map((x) => x.id)
    );
    return items.filter((d) => keep.has(d.session.id));
  };

  const todaysItems = hideGhostItems(dated.filter((d) => isSameDay(d.date, today)));
  const tomorrowItems = hideGhostItems(
    dated.filter((d) => isSameDay(d.date, tomorrow))
  );

  const currentWeek = weekNumberFor(planStart, today);
  const inPlanRange = currentWeek >= 1 && currentWeek <= plan.weekCount;

  // Which week a session belongs to follows from where it actually sits, for
  // the same reason as above: a session moved into next week should count
  // towards next week's load, not the week it was written in.
  const weekItems = dated.filter(
    (d) => weekNumberFor(planStart, d.date) === currentWeek
  );
  const weekSessions = weekItems.map((d) => d.session);
  const weekTssPlanned = weekSessions.reduce((sum, s) => sum + (s.tss || 0), 0);
  // Counts what was actually trained. "substituted" days matter here: the
  // athlete did train, just not the prescribed discipline, and ignoring that
  // understated the week and left the plan looking untouched.
  const weekTssCompleted = weekSessions
    .filter((s) => didTrain(s.status))
    .reduce((sum, s) => sum + (s.actualTss ?? s.tss ?? 0), 0);

  const weekMeta = weekSessions[0];

  return {
    date: toISODate(today),
    hasPlan: true,
    inPlanRange,
    week: inPlanRange ? currentWeek : null,
    phase: weekMeta?.phase ?? null,
    summary: weekMeta?.summary ?? null,
    sessions: todaysItems.map(toDaySession),
    tomorrow: tomorrowItems.map(toDaySession),
    weekTssPlanned,
    weekTssCompleted,
    daysUntilRace: plan.targetRaceDate
      ? daysBetween(today, plan.targetRaceDate)
      : null,
    raceDate: plan.targetRaceDate ? toISODate(plan.targetRaceDate) : null,
  };
}

/** Confirms a session belongs to the given user before allowing an update. */
export async function sessionBelongsToUser(
  sessionId: string,
  userId: string
): Promise<boolean> {
  const session = await prisma.plannedSession.findUnique({
    where: { id: sessionId },
    include: { plan: true },
  });
  return session?.plan.userId === userId;
}

// ---- Full season view (every week to race day) --------------------------

/** The athlete's current plan plus its outline, or null. */
export async function getLatestPlanWithOutline(userId: string) {
  return prisma.trainingPlan.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: { outline: { orderBy: { week: "asc" } } },
  });
}

/**
 * Adds (or replaces) detailed sessions for specific weeks of an EXISTING plan,
 * leaving the rest of the plan and its outline untouched.
 */
export async function addDetailedWeeks(
  planId: string,
  weeks: PlanWeek[]
): Promise<number> {
  if (weeks.length === 0) return 0;

  const plan = await prisma.trainingPlan.findUnique({
    where: { id: planId },
    select: { startDate: true },
  });
  const planStart = plan?.startDate ?? mondayOfWeek(new Date());

  const weekNumbers = weeks.map((w) => w.week);

  // Replace any existing detail for those weeks so re-generating is safe.
  await prisma.plannedSession.deleteMany({
    where: { planId, week: { in: weekNumbers } },
  });

  const rows = weeks.flatMap((week) =>
    week.sessions.map((s) => {
      // Sessions must be born with a real calendar date; the adaptation engine
      // queries by scheduledDate and cannot see undated sessions.
      const date = sessionDate(planStart, week.week, s.day);
      return {
        planId,
        week: week.week,
        phase: week.phase ?? null,
        summary: week.summary ?? null,
        day: s.day,
        scheduledDate: date,
        originalDate: date,
        discipline: s.discipline,
        type: s.type,
        duration: s.duration,
        tss: typeof s.tss === "number" ? s.tss : parseInt(String(s.tss)) || 0,
        originalTss: typeof s.tss === "number" ? s.tss : parseInt(String(s.tss)) || 0,
        instructions: s.instructions ?? null,
        pace: s.pace ?? null,
      };
    })
  );

  if (rows.length > 0) {
    await prisma.plannedSession.createMany({ data: collapseDayDuplicates(rows) });
  }

  // Keep the "how many weeks are detailed" counter accurate.
  const detailed = await prisma.plannedSession.findMany({
    where: { planId },
    select: { week: true },
    distinct: ["week"],
  });
  await prisma.trainingPlan.update({
    where: { id: planId },
    data: { detailedWeeks: detailed.length },
  });

  return rows.length;
}

export interface SeasonWeek {
  week: number;
  phase: string;
  focus: string | null;
  targetHours: number | null;
  targetTss: number | null;
  isRaceWeek: boolean;
  hasDetail: boolean;
  startDate: string | null;
  isCurrentWeek: boolean;
  sessions: SeasonSession[];
}

/**
 * A session as the calendar needs it: identified, dated, and carrying enough
 * state for the UI to know whether it can be dragged.
 *
 * Distinct from `PlanSession`, which is the shape the AI coach writes and has
 * no database identity yet.
 */
export interface SeasonSession {
  id: string;
  day: string;
  /** Real calendar day, ISO yyyy-mm-dd. */
  date: string;
  discipline: string;
  type: string;
  duration: string;
  /** Prescribed load. Zero on unplanned training, which was never prescribed. */
  tss: number;
  /** What it actually cost, once reconciled against Strava. */
  actualTss: number | null;
  /** The Strava activity that evidences this, when it is marked as done. */
  evidence: string | null;
  /**
   * What the session actually costs, split by kind. A single number makes a
   * 2-hour ride and a 1-hour run look equivalent when the run does roughly
   * four times the impact damage — which is what the athlete has to recover
   * from, and what the engine has been reasoning about all along.
   */
  load: { metabolic: number; mechanical: number; neuromuscular: number; upper: number };
  instructions: string;
  pace: string;
  status: string;
  isAnchor: boolean;
  /** The athlete's own correction to what actually happened, if they gave one. */
  athleteNote: string | null;
  /** The athlete's read of how hard it felt (e.g. "very hard"). Athlete-sourced. */
  difficulty: string | null;
  /** What the athlete noticed in the body (e.g. "left calf tight"). Athlete-sourced. */
  bodyNote: string | null;
}

export interface SeasonView {
  hasPlan: boolean;
  totalWeeks: number;
  detailedWeeks: number;
  raceDate: string | null;
  currentWeek: number | null;
  /** Last committed day; sessions on or before it cannot be rescheduled. */
  frozenUntil: string;
  weeks: SeasonWeek[];
}

/**
 * Returns EVERY week from plan start to race day. Weeks that have detailed
 * sessions include them; the rest still show their phase and targets so the
 * athlete can see the whole season shape.
 */
export async function getSeasonView(
  userId: string,
  referenceDate: Date = new Date()
): Promise<SeasonView> {
  const plan = await prisma.trainingPlan.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: {
      sessions: { orderBy: [{ week: "asc" }, { id: "asc" }] },
      outline: { orderBy: { week: "asc" } },
    },
  });

  if (!plan) {
    return {
      hasPlan: false,
      totalWeeks: 0,
      detailedWeeks: 0,
      raceDate: null,
      currentWeek: null,
      frozenUntil: freezeBoundary(referenceDate),
      weeks: [],
    };
  }

  const planStart = plan.startDate ?? plan.createdAt;
  const currentWeek = weekNumberFor(planStart, referenceDate);

  // The executed evidence for any session marked done. A completed or unplanned
  // session carries a `sourceActivityId`; its *actual* cost must be computed
  // from that activity's TSS/intensity/duration, not from `tss` on the plan row
  // (which is, and must stay, zero for unplanned training and prescribed for
  // planned). Merchandising a done session at its prescribed value would show
  // an all-zero load breakdown and hide what recovery actually demands.
  const evidence = new Map<
    string,
    { discipline: string; name: string; estimatedTss: number | null; distance: number | null; elevationGain: number | null }
  >();
  const activitiesForEvidence = await prisma.stravaActivity.findMany({
    where: { userId, startDate: { gte: planStart } },
    select: {
      id: true, discipline: true, name: true, estimatedTss: true,
      distance: true, elevationGain: true,
    },
  });
  for (const a of activitiesForEvidence) evidence.set(a.id, a);

  /** Load a session is judged on: executed when it happened, else prescribed. */
  const sessionLoadFor = (s: {
    sourceActivityId: string | null;
    discipline: string;
    type: string;
    tss: number;
    actualTss: number | null;
    status: string;
  }) => {
    const a = s.sourceActivityId ? evidence.get(s.sourceActivityId) : null;
    if (a) {
      return loadVectorFor({
        discipline: a.discipline,
        tss: a.estimatedTss ?? 0,
        type: a.name,
        distanceKm: a.distance ? a.distance / 1000 : null,
        elevationGainM: a.elevationGain,
      });
    }
    // No recorded activity (planned/adapted, or substituted→kept as baseline):
    // value it at what it actually cost when trained, else at what was planned.
    return loadVectorFor({
      discipline: s.discipline,
      tss: didTrain(s.status) ? (s.actualTss ?? s.tss) : s.tss,
      type: s.type,
    });
  };

  // Group sessions by week.
  //
  // `scheduledDate` wins where it exists: it is what the adaptation engine and
  // manual rescheduling write, and the `week` column can lag behind a move.
  // Deriving the week from the date means a moved session appears where it
  // actually is, not where it was originally written.
  const sessionsByWeek = new Map<number, SeasonSession[]>();
  for (const s of plan.sessions) {
    const date =
      s.scheduledDate ?? sessionDate(planStart, s.week, s.day) ?? null;
    if (!date) continue;
    const week = s.scheduledDate ? weekNumberFor(planStart, date) : s.week;
    if (!sessionsByWeek.has(week)) sessionsByWeek.set(week, []);
    sessionsByWeek.get(week)!.push({
      id: s.id,
      day: s.day,
      date: toISODate(date),
      discipline: s.discipline,
      type: displayTypeFor(s, evidence),
      duration: s.duration,
      tss: s.tss,
      actualTss: s.actualTss ?? null,
      evidence: s.sourceActivityId ?? null,
      load: sessionLoadFor(s),
      instructions: s.instructions ?? "",
      pace: s.pace ?? "",
      status: s.status,
      isAnchor: s.isAnchor,
      athleteNote: s.athleteNote ?? null,
      difficulty: s.difficulty ?? null,
      bodyNote: s.bodyNote ?? null,
    });
  }
  // Chronological within each week, so the calendar can render rows in order.
  //
  // Ghost sessions are dropped from the view but NOT from the database
  // (v3 §2.4): on a day the athlete trained, showing the session they didn't
  // do next to the one they did is just noise. Today's screen already did
  // this; the calendar did not, which is why the two disagreed.
  for (const [week, list] of sessionsByWeek) {
    list.sort((a, b) => a.date.localeCompare(b.date));
    // A past day shows what happened, not what was once intended. The view is
    // anchored to `referenceDate` (the same one that drives `currentWeek`), so
    // it does not silently shift as the real clock advances.
    sessionsByWeek.set(week, hidePastNonEvents(hideGhosts(list), toISODate(referenceDate)));
  }

  const outlineByWeek = new Map(plan.outline.map((o) => [o.week, o]));
  const totalWeeks = Math.max(
    plan.weekCount,
    plan.outline.length,
    ...(plan.sessions.length ? plan.sessions.map((s) => s.week) : [0])
  );

  const weeks: SeasonWeek[] = [];
  for (let i = 1; i <= totalWeeks; i++) {
    const o = outlineByWeek.get(i);
    const sessions = sessionsByWeek.get(i) ?? [];
    // Anchor on the same Monday `sessionDate()` uses. Using the raw plan
    // startDate here made the week header disagree with the sessions inside it
    // whenever the plan was generated in another timezone.
    const weekStart = addDays(planWeekOneMonday(planStart), (i - 1) * 7);

    weeks.push({
      week: i,
      phase: o?.phase ?? (sessions.length ? "Training" : "Planned"),
      focus: o?.focus ?? null,
      targetHours: o?.targetHours ?? null,
      targetTss: o?.targetTss ?? null,
      isRaceWeek: o?.isRaceWeek ?? false,
      hasDetail: sessions.length > 0,
      startDate: toISODate(weekStart),
      isCurrentWeek: i === currentWeek,
      sessions,
    });
  }

  return {
    hasPlan: true,
    totalWeeks,
    detailedWeeks: plan.detailedWeeks || sessionsByWeek.size,
    raceDate: toISODate(plan.targetRaceDate),
    currentWeek: currentWeek >= 1 && currentWeek <= totalWeeks ? currentWeek : null,
    frozenUntil: freezeBoundary(referenceDate),
    weeks,
  };
}

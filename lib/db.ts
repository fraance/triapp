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
} from "./plan-dates";

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
    week.sessions.map((s) => ({
      planId: plan.id,
      week: week.week,
      phase: week.phase ?? null,
      summary: week.summary ?? null,
      day: s.day,
      discipline: s.discipline,
      type: s.type,
      duration: s.duration,
      tss: typeof s.tss === "number" ? s.tss : parseInt(String(s.tss)) || 0,
      instructions: s.instructions ?? null,
      pace: s.pace ?? null,
    }))
  );

  if (flatSessions.length > 0) {
    await prisma.plannedSession.createMany({ data: flatSessions });
  }

  return plan;
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

// ---- "Today" view -------------------------------------------------------

export interface DaySession {
  id: string;
  discipline: string;
  type: string;
  duration: string;
  tss: number;
  instructions: string;
  pace: string;
  status: string;
  day: string;
  week: number;
  date: string; // YYYY-MM-DD
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

  // Attach a real calendar date to every session.
  const dated = plan.sessions
    .map((s) => {
      const date = sessionDate(planStart, s.week, s.day);
      return date ? { session: s, date } : null;
    })
    .filter((x): x is { session: (typeof plan.sessions)[number]; date: Date } => x !== null);

  const toDaySession = (item: { session: any; date: Date }): DaySession => ({
    id: item.session.id,
    discipline: item.session.discipline,
    type: item.session.type,
    duration: item.session.duration,
    tss: item.session.tss,
    instructions: item.session.instructions ?? "",
    pace: item.session.pace ?? "",
    status: item.session.status,
    day: item.session.day,
    week: item.session.week,
    date: toISODate(item.date),
  });

  const todaysItems = dated.filter((d) => isSameDay(d.date, today));
  const tomorrowItems = dated.filter((d) => isSameDay(d.date, tomorrow));

  const currentWeek = weekNumberFor(planStart, today);
  const inPlanRange = currentWeek >= 1 && currentWeek <= plan.weekCount;

  const weekSessions = plan.sessions.filter((s) => s.week === currentWeek);
  const weekTssPlanned = weekSessions.reduce((sum, s) => sum + (s.tss || 0), 0);
  // Counts what was actually trained. "substituted" days matter here: the
  // athlete did train, just not the prescribed discipline, and ignoring that
  // understated the week and left the plan looking untouched.
  const weekTssCompleted = weekSessions
    .filter((s) => s.status === "completed" || s.status === "substituted")
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

  const weekNumbers = weeks.map((w) => w.week);

  // Replace any existing detail for those weeks so re-generating is safe.
  await prisma.plannedSession.deleteMany({
    where: { planId, week: { in: weekNumbers } },
  });

  const rows = weeks.flatMap((week) =>
    week.sessions.map((s) => ({
      planId,
      week: week.week,
      phase: week.phase ?? null,
      summary: week.summary ?? null,
      day: s.day,
      discipline: s.discipline,
      type: s.type,
      duration: s.duration,
      tss: typeof s.tss === "number" ? s.tss : parseInt(String(s.tss)) || 0,
      instructions: s.instructions ?? null,
      pace: s.pace ?? null,
    }))
  );

  if (rows.length > 0) {
    await prisma.plannedSession.createMany({ data: rows });
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
  sessions: PlanSession[];
}

export interface SeasonView {
  hasPlan: boolean;
  totalWeeks: number;
  detailedWeeks: number;
  raceDate: string | null;
  currentWeek: number | null;
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
      weeks: [],
    };
  }

  const planStart = plan.startDate ?? plan.createdAt;
  const currentWeek = weekNumberFor(planStart, referenceDate);

  // Group detailed sessions by week.
  const sessionsByWeek = new Map<number, PlanSession[]>();
  for (const s of plan.sessions) {
    if (!sessionsByWeek.has(s.week)) sessionsByWeek.set(s.week, []);
    sessionsByWeek.get(s.week)!.push({
      day: s.day,
      discipline: s.discipline,
      type: s.type,
      duration: s.duration,
      tss: s.tss,
      instructions: s.instructions ?? "",
      pace: s.pace ?? "",
    });
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
    const weekStart = addDays(startOfDay(planStart), (i - 1) * 7);

    weeks.push({
      week: i,
      phase: o?.phase ?? (sessions.length ? "Training" : "Planned"),
      focus: o?.focus ?? null,
      targetHours: o?.targetHours ?? null,
      targetTss: o?.targetTss ?? null,
      isRaceWeek: o?.isRaceWeek ?? false,
      hasDetail: sessions.length > 0,
      startDate: weekStart.toISOString().split("T")[0],
      isCurrentWeek: i === currentWeek,
      sessions,
    });
  }

  return {
    hasPlan: true,
    totalWeeks,
    detailedWeeks: plan.detailedWeeks || sessionsByWeek.size,
    raceDate: plan.targetRaceDate.toISOString().split("T")[0],
    currentWeek: currentWeek >= 1 && currentWeek <= totalWeeks ? currentWeek : null,
    weeks,
  };
}

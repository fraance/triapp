/**
 * Time availability vs physical capacity.
 *
 * These are two different limits and must never be conflated:
 *
 *  - AVAILABILITY is a life constraint. How many hours the athlete can give to
 *    training. Only they can tell us this — it cannot be derived from their
 *    history, because training less than you're able to is not evidence of
 *    having no time.
 *
 *  - CAPACITY is a physiological limit. How much load their body can currently
 *    absorb, and how fast that can safely grow. This IS derived from what they
 *    have actually been doing.
 *
 * A plan must fit inside BOTH. The binding constraint is whichever is smaller.
 */
import { prisma } from "./prisma";

export const DAY_FIELDS = [
  ["monHours", "Monday"],
  ["tueHours", "Tuesday"],
  ["wedHours", "Wednesday"],
  ["thuHours", "Thursday"],
  ["friHours", "Friday"],
  ["satHours", "Saturday"],
  ["sunHours", "Sunday"],
] as const;

export interface AvailabilitySummary {
  isSet: boolean;
  /** The athlete says time is not a limiting factor for them. */
  noTimeConstraints: boolean;
  totalHours: number;
  byDay: Array<{ day: string; hours: number }>;
  trainingDays: number;
  longestDayHours: number;
  longSessionDay: string | null;
  constraints: string | null;
  poolAccess: boolean;
  gymAccess: boolean;
  indoorTrainer: boolean;
}

export interface CapacitySummary {
  hasData: boolean;
  /** What they have actually been doing recently. */
  recentWeeklyHours: number;
  recentWeeklyTss: number;
  /** Their biggest recent week — evidence of what they can absorb. */
  peakWeeklyHours: number;
  /** The most we should build to in the next week, at a safe ramp rate. */
  safeNextWeekHours: number;
  safeNextWeekTss: number;
  weeksAnalysed: number;
  basis: string;
}

export interface TrainingBudget {
  availability: AvailabilitySummary;
  capacity: CapacitySummary;
  /** The limit the plan must respect this week, and why. */
  bindingConstraint: "time" | "capacity" | "unknown";
  recommendedWeeklyHours: number | null;
  explanation: string;
}

/** Safe week-on-week volume increase. */
export const SAFE_RAMP_RATE = 1.1;

export async function getAvailability(
  userId: string
): Promise<AvailabilitySummary> {
  const a = await prisma.trainingAvailability.findUnique({ where: { userId } });

  if (!a) {
    return {
      isSet: false,
      noTimeConstraints: false,
      totalHours: 0,
      byDay: DAY_FIELDS.map(([, day]) => ({ day, hours: 0 })),
      trainingDays: 0,
      longestDayHours: 0,
      longSessionDay: null,
      constraints: null,
      poolAccess: true,
      gymAccess: true,
      indoorTrainer: false,
    };
  }

  const byDay = DAY_FIELDS.map(([field, day]) => ({
    day,
    hours: (a as any)[field] as number,
  }));
  const total = byDay.reduce((s, d) => s + d.hours, 0);

  return {
    // Declaring "no constraints" is itself a valid, complete answer.
    isSet: a.noTimeConstraints || total > 0,
    noTimeConstraints: a.noTimeConstraints,
    totalHours: Math.round(total * 10) / 10,
    byDay,
    trainingDays: byDay.filter((d) => d.hours > 0).length,
    longestDayHours: byDay.reduce((m, d) => Math.max(m, d.hours), 0),
    longSessionDay: a.longSessionDay,
    constraints: a.constraints,
    poolAccess: a.poolAccess,
    gymAccess: a.gymAccess,
    indoorTrainer: a.indoorTrainer,
  };
}

export async function saveAvailability(
  userId: string,
  data: Record<string, any>
) {
  const clean: Record<string, any> = {};
  for (const [field] of DAY_FIELDS) {
    if (field in data) {
      const n = Number(data[field]);
      clean[field] = Number.isFinite(n) && n > 0 ? Math.min(n, 24) : 0;
    }
  }
  for (const key of ["longSessionDay", "constraints"]) {
    if (key in data) clean[key] = data[key] || null;
  }
  for (const key of ["poolAccess", "gymAccess", "indoorTrainer", "noTimeConstraints"]) {
    if (key in data) clean[key] = Boolean(data[key]);
  }

  return prisma.trainingAvailability.upsert({
    where: { userId },
    create: { userId, ...clean },
    update: clean,
  });
}

/**
 * Works out what the athlete's body is currently prepared for, based on what
 * they have actually been doing. Uses their recent average and their biggest
 * recent week, then applies a safe ramp rate.
 */
export async function getCapacity(
  userId: string,
  weeksBack = 6
): Promise<CapacitySummary> {
  const since = new Date(Date.now() - weeksBack * 7 * 24 * 60 * 60 * 1000);
  const activities = await prisma.stravaActivity.findMany({
    where: { userId, startDate: { gte: since } },
    select: { startDate: true, movingTime: true, estimatedTss: true },
  });

  if (activities.length === 0) {
    return {
      hasData: false,
      recentWeeklyHours: 0,
      recentWeeklyTss: 0,
      peakWeeklyHours: 0,
      safeNextWeekHours: 0,
      safeNextWeekTss: 0,
      weeksAnalysed: 0,
      basis: "No recent training data to judge capacity from.",
    };
  }

  // Bucket into calendar weeks.
  const weekBuckets = new Map<number, { seconds: number; tss: number }>();
  for (const a of activities) {
    const weekIndex = Math.floor(
      (a.startDate.getTime() - since.getTime()) / (7 * 24 * 60 * 60 * 1000)
    );
    const bucket = weekBuckets.get(weekIndex) ?? { seconds: 0, tss: 0 };
    bucket.seconds += a.movingTime;
    bucket.tss += a.estimatedTss;
    weekBuckets.set(weekIndex, bucket);
  }

  const weeks = Array.from(weekBuckets.values());
  const avgHours =
    weeks.reduce((s, w) => s + w.seconds, 0) / 3600 / weeksBack;
  const avgTss = weeks.reduce((s, w) => s + w.tss, 0) / weeksBack;
  const peakHours = Math.max(...weeks.map((w) => w.seconds)) / 3600;

  // Build from the recent average, but never below what they've already proven
  // they can handle in a single week.
  const base = Math.max(avgHours, peakHours * 0.8);

  return {
    hasData: true,
    recentWeeklyHours: Math.round(avgHours * 10) / 10,
    recentWeeklyTss: Math.round(avgTss),
    peakWeeklyHours: Math.round(peakHours * 10) / 10,
    safeNextWeekHours: Math.round(base * SAFE_RAMP_RATE * 10) / 10,
    safeNextWeekTss: Math.round(avgTss * SAFE_RAMP_RATE),
    weeksAnalysed: weeksBack,
    basis: `Averaged ${Math.round(avgHours * 10) / 10} h/week over the last ${weeksBack} weeks, with a biggest week of ${Math.round(peakHours * 10) / 10} h.`,
  };
}

/**
 * Combines both limits into the number the plan should actually target.
 */
export async function getTrainingBudget(
  userId: string
): Promise<TrainingBudget> {
  const [availability, capacity] = await Promise.all([
    getAvailability(userId),
    getCapacity(userId),
  ]);

  if (!availability.isSet && !capacity.hasData) {
    return {
      availability,
      capacity,
      bindingConstraint: "unknown",
      recommendedWeeklyHours: null,
      explanation:
        "We don't know how much time the athlete has, and there is no training history to judge their capacity. Ask them how many hours a week they can train.",
    };
  }

  // The athlete has told us time is not a constraint. Their body is then the
  // only limit, so we build entirely around safe physiological progression.
  if (availability.noTimeConstraints) {
    if (!capacity.hasData) {
      return {
        availability,
        capacity,
        bindingConstraint: "capacity",
        recommendedWeeklyHours: null,
        explanation:
          "The athlete has no meaningful time constraints, but there is no training history to judge their capacity. Start conservatively, keep the first week comfortable, and increase by no more than 10% per week.",
      };
    }
    return {
      availability,
      capacity,
      bindingConstraint: "capacity",
      recommendedWeeklyHours: capacity.safeNextWeekHours,
      explanation: `The athlete has no meaningful time constraints, so their body is the only limit. They have been training ${capacity.recentWeeklyHours} h/week with a biggest week of ${capacity.peakWeeklyHours} h. Build around ${capacity.safeNextWeekHours} h/week and progress by at most 10% per week — having the time available is not a reason to jump the volume.`,
    };
  }

  if (!availability.isSet) {
    return {
      availability,
      capacity,
      bindingConstraint: "unknown",
      recommendedWeeklyHours: null,
      explanation: `The athlete has not told us how much time they have. Their body currently looks ready for about ${capacity.safeNextWeekHours} h/week, but we must not assume they have that much time available.`,
    };
  }

  if (!capacity.hasData) {
    return {
      availability,
      capacity,
      bindingConstraint: "time",
      recommendedWeeklyHours: availability.totalHours,
      explanation: `The athlete has ${availability.totalHours} h/week available. With no training history, start conservatively within that time and build gradually.`,
    };
  }

  const timeLimit = availability.totalHours;
  const bodyLimit = capacity.safeNextWeekHours;
  const binding = timeLimit <= bodyLimit ? "time" : "capacity";
  const recommended = Math.min(timeLimit, bodyLimit);

  const explanation =
    binding === "time"
      ? `The athlete has ${timeLimit} h/week available, and their body could handle about ${bodyLimit} h/week. TIME is the limiting factor: plan for ${recommended} h/week and make every session count.`
      : `The athlete has ${timeLimit} h/week available, but has only been training ${capacity.recentWeeklyHours} h/week. THEIR BODY is the limiting factor: plan around ${recommended} h/week and build gradually — do not fill the spare time straight away.`;

  return {
    availability,
    capacity,
    bindingConstraint: binding,
    recommendedWeeklyHours: Math.round(recommended * 10) / 10,
    explanation,
  };
}

/** Renders the budget as instructions for the AI coach. */
export function formatBudgetForPrompt(budget: TrainingBudget): string {
  const lines: string[] = ["TIME AVAILABLE AND PHYSICAL CAPACITY:"];

  if (budget.availability.noTimeConstraints) {
    lines.push(
      "- The athlete has NO meaningful time constraints — they can train whenever needed."
    );
    lines.push(
      "- Session length and scheduling are therefore governed only by what their body can absorb, not by their diary."
    );
    if (budget.availability.longSessionDay) {
      lines.push(`- They still prefer their long session on ${budget.availability.longSessionDay}.`);
    }
    if (budget.availability.constraints) {
      lines.push(`- Notes: ${budget.availability.constraints}`);
    }
  } else if (budget.availability.isSet) {
    const days = budget.availability.byDay
      .map((d) => `${d.day.slice(0, 3)} ${d.hours}h`)
      .join(", ");
    lines.push(`- Time available per day: ${days} (total ${budget.availability.totalHours} h/week).`);
    lines.push(
      "- Each day's sessions MUST fit inside that day's available time. Do not schedule a 2 h ride on a 1 h day."
    );
    if (budget.availability.longSessionDay) {
      lines.push(`- Preferred day for the long session: ${budget.availability.longSessionDay}.`);
    }
    if (budget.availability.constraints) {
      lines.push(`- Constraints: ${budget.availability.constraints}`);
    }
  } else {
    lines.push("- The athlete has NOT told us how much time they have. Do not assume.");
  }

  const facilities: string[] = [];
  if (!budget.availability.poolAccess) facilities.push("NO pool access — swim sessions must be open water or dryland");
  if (!budget.availability.gymAccess) facilities.push("no gym — strength work must be bodyweight");
  if (budget.availability.indoorTrainer) facilities.push("has an indoor trainer, so bad weather is not a blocker for cycling");
  if (facilities.length) lines.push(`- Facilities: ${facilities.join("; ")}.`);

  if (budget.capacity.hasData) {
    lines.push(
      `- Current physical capacity: training ${budget.capacity.recentWeeklyHours} h/week (~${budget.capacity.recentWeeklyTss} TSS), biggest recent week ${budget.capacity.peakWeeklyHours} h.`
    );
    lines.push(
      `- Safe progression: do not exceed roughly ${budget.capacity.safeNextWeekHours} h/week in the opening week, and increase by at most 10% per week.`
    );
  }

  lines.push(`- ${budget.explanation}`);

  if (budget.recommendedWeeklyHours) {
    lines.push(
      `- TARGET: build the plan around ${budget.recommendedWeeklyHours} h/week to start.`
    );
  }

  return lines.join("\n");
}

/**
 * Maps training-plan sessions ("Week 2, Wednesday") onto real calendar dates.
 *
 * A plan is anchored by its `startDate`, which is always the MONDAY of week 1.
 * From there:  sessionDate = startDate + (week - 1) * 7 days + dayOffset
 *
 * All calculations are done on local calendar days (time set to midnight) so
 * that "today" means the athlete's actual day, not a UTC timestamp.
 */

export const DAY_ORDER = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

/** Normalises a day name ("monday", " MONDAY ") to its index 0..6, or -1. */
export function dayNameToIndex(day: string): number {
  if (!day) return -1;
  const normalized = day.trim().toLowerCase();
  return DAY_ORDER.findIndex((d) => d.toLowerCase() === normalized);
}

/** Strips the time portion, returning local midnight for that calendar day. */
export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * Returns the Monday of the week containing `date`.
 * (JS getDay(): 0=Sunday..6=Saturday, so Sunday belongs to the week that began
 * on the previous Monday.)
 */
export function mondayOfWeek(date: Date): Date {
  const d = startOfDay(date);
  const jsDay = d.getDay();
  const daysSinceMonday = jsDay === 0 ? 6 : jsDay - 1;
  d.setDate(d.getDate() - daysSinceMonday);
  return d;
}

export function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

/** The real calendar date for a given session, or null if the day is invalid. */
export function sessionDate(
  planStartDate: Date,
  week: number,
  day: string
): Date | null {
  const dayIndex = dayNameToIndex(day);
  if (dayIndex < 0) return null;
  const base = startOfDay(planStartDate);
  return addDays(base, (week - 1) * 7 + dayIndex);
}

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Whole days from `from` to `to` (positive = in the future). */
export function daysBetween(from: Date, to: Date): number {
  const a = startOfDay(from).getTime();
  const b = startOfDay(to).getTime();
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}

/** Which plan week does `date` fall into? (1-based; 0 if before the plan.) */
export function weekNumberFor(planStartDate: Date, date: Date): number {
  const diff = daysBetween(planStartDate, date);
  if (diff < 0) return 0;
  return Math.floor(diff / 7) + 1;
}

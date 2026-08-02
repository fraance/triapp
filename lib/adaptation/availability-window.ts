/**
 * Availability windows for the solver (v3 §4.3, "The Job Problem Constraint").
 *
 * > "Human beings have jobs, meaning rolling calculation windows cannot
 * >  override real life. Permanently lock long-duration sessions to the user's
 * >  pre-selected available days."
 *
 * Until now the engine inferred "weekends" as the days a long session could
 * live. That is a guess, and a wrong one for anyone who rides on a Wednesday
 * or works weekends. This module replaces the guess with the athlete's own
 * declared hours.
 *
 * Everything here is a pure function of a supplied availability record, so the
 * solver stays deterministic and testable.
 *
 * Date handling: all conversions go through `localISO`. `toISOString()` on a
 * local midnight rolls back a day in any positive UTC offset, which has
 * repeatedly corrupted date windows in this codebase.
 */
import { localISO } from "./load-vector";

/** Hours available for each weekday, indexed the same way as Date#getDay(). */
export interface WeeklyHours {
  /** 0 = Sunday … 6 = Saturday, matching JavaScript's getDay(). */
  byWeekday: number[];
  /** The athlete says time is not a limiting factor. */
  noTimeConstraints: boolean;
  /** Whether the athlete has actually declared anything. */
  isSet: boolean;
  /** Their stated preference for the week's longest session, if any. */
  longSessionDay?: string | null;
}

const DAY_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

/** Builds `WeeklyHours` from the TrainingAvailability record. */
export function weeklyHoursFrom(
  record: {
    noTimeConstraints: boolean;
    monHours: number;
    tueHours: number;
    wedHours: number;
    thuHours: number;
    friHours: number;
    satHours: number;
    sunHours: number;
    longSessionDay?: string | null;
  } | null
): WeeklyHours {
  if (!record) {
    return { byWeekday: [], noTimeConstraints: false, isSet: false };
  }
  const byWeekday = [
    record.sunHours,
    record.monHours,
    record.tueHours,
    record.wedHours,
    record.thuHours,
    record.friHours,
    record.satHours,
  ].map((h) => (Number.isFinite(h) ? Math.max(0, h) : 0));

  const declared = byWeekday.some((h) => h > 0);
  return {
    byWeekday,
    noTimeConstraints: record.noTimeConstraints,
    // "No time constraints" is itself a declaration, so it counts as set.
    isSet: declared || record.noTimeConstraints,
    longSessionDay: record.longSessionDay ?? null,
  };
}

/** Hours available on a given date. `null` means the athlete never said. */
export function hoursOn(availability: WeeklyHours, isoDate: string): number | null {
  if (!availability.isSet) return null;
  if (availability.noTimeConstraints) return Infinity;
  const day = new Date(isoDate + "T00:00:00").getDay();
  return availability.byWeekday[day] ?? 0;
}

/**
 * Can a session of `minutes` fit on this date?
 *
 * An athlete who has declared nothing is never told "no": we do not invent a
 * limit they did not give us (project rule 2). They simply go unconstrained.
 */
export function fitsOn(
  availability: WeeklyHours,
  isoDate: string,
  minutes: number
): boolean {
  const hours = hoursOn(availability, isoDate);
  if (hours === null) return true;
  if (hours === Infinity) return true;
  return minutes <= hours * 60 + 1e-9;
}

/**
 * The dates within a horizon where a session of `minutes` could actually
 * happen. This is what pins a long session to real life.
 */
export function datesThatFit(
  availability: WeeklyHours,
  fromISO: string,
  days: number,
  minutes: number
): string[] {
  const out: string[] = [];
  const cursor = new Date(fromISO + "T00:00:00");
  for (let i = 0; i < days; i++) {
    const iso = localISO(cursor);
    if (fitsOn(availability, iso, minutes)) out.push(iso);
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

/** Dates in the horizon with no training time at all. */
export function unavailableDates(
  availability: WeeklyHours,
  fromISO: string,
  days: number
): string[] {
  if (!availability.isSet || availability.noTimeConstraints) return [];
  const out: string[] = [];
  const cursor = new Date(fromISO + "T00:00:00");
  for (let i = 0; i < days; i++) {
    const iso = localISO(cursor);
    if ((hoursOn(availability, iso) ?? 1) <= 0) out.push(iso);
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

/**
 * The athlete's preferred long-session date inside the horizon, if they named
 * a day and it has enough time.
 */
export function preferredLongDates(
  availability: WeeklyHours,
  fromISO: string,
  days: number,
  minutes: number
): string[] {
  const named = availability.longSessionDay?.trim().toLowerCase();
  if (!named) return [];
  const idx = DAY_INDEX[named];
  if (idx === undefined) return [];
  return datesThatFit(availability, fromISO, days, minutes).filter(
    (d) => new Date(d + "T00:00:00").getDay() === idx
  );
}

/** Human-readable summary, used in explanations and the handoff. */
export function describeAvailability(a: WeeklyHours): string {
  if (!a.isSet) return "no availability declared";
  if (a.noTimeConstraints) return "no time constraints declared";
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return a.byWeekday
    .map((h, i) => `${names[i]} ${h}h`)
    .filter((_, i) => a.byWeekday[i] > 0 || true)
    .join(", ");
}

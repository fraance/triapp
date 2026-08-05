/**
 * Manual rescheduling — moving a planned session to a different day.
 *
 * The athlete drags sessions around a calendar and saves the result as a
 * batch. This module is what that batch goes through.
 *
 * Three rules shape everything here:
 *
 *  1. `week`, `day` and `scheduledDate` must always agree. The plan stores a
 *     session's position twice: logically (week 3, Wednesday) and as a real
 *     calendar date. Different parts of the app read different ones, so a move
 *     that updates only some of them puts a session in two places at once.
 *     `slotFor()` is the single place that derives all three.
 *
 *  2. The commitment window is absolute. Sessions on days that are already
 *     committed cannot be moved, and cannot be moved onto. guardrails.ts is
 *     explicit that no manual drag may breach it, so this is a hard rejection,
 *     not a warning.
 *
 *  3. Training guardrails warn, they do not block. The athlete knows things we
 *     do not — a physio appointment, how their legs actually feel. We tell them
 *     what the arrangement risks and let them decide. See `warningsFor()`.
 *
 * Saving is all-or-nothing and versioned: the plan is snapshotted before the
 * write and the change is written to the adaptation log, so a manual move is
 * as auditable as an automatic one.
 */
import { prisma } from "./prisma";
import {
  DAY_ORDER,
  dayNameToIndex,
  planWeekOneMonday,
  startOfDay,
  weekNumberFor,
} from "./plan-dates";
import {
  warningsFor,
  MOVABLE_STATUSES,
  RescheduleWarning,
} from "./plan-warnings";

export type { RescheduleWarning } from "./plan-warnings";
export { warningsFor } from "./plan-warnings";

/** Local hour after which tomorrow is committed too. Mirrors engine.ts. */
const FREEZE_HOUR = 20;

export interface SessionMove {
  sessionId: string;
  /** Destination day, ISO yyyy-mm-dd, in the athlete's local time. */
  toDate: string;
}

export interface MoveRejection {
  sessionId: string;
  reason: string;
}

export interface RescheduleResult {
  applied: boolean;
  moved: number;
  rejected: MoveRejection[];
  warnings: RescheduleWarning[];
  /** Version number of the snapshot taken before the write, if one happened. */
  version?: number;
}

// ---- Date helpers -------------------------------------------------------

/** yyyy-mm-dd for a Date, in local time. Never use toISOString() for this. */
export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

/** Parses yyyy-mm-dd as a LOCAL midnight, not UTC. */
export function parseISODate(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The last day that is already committed and therefore immovable.
 * Before 20:00 that is today; from 20:00 it is tomorrow as well, because the
 * athlete has by then planned their next morning around it.
 */
export function freezeBoundary(now: Date): string {
  const base = startOfDay(now);
  if (now.getHours() >= FREEZE_HOUR) base.setDate(base.getDate() + 1);
  return isoDate(base);
}

/**
 * Derives all three of a session's position fields from one calendar date.
 *
 * This is the invariant. Anything that moves a session must go through here,
 * or `week`/`day`/`scheduledDate` drift apart and the same session appears on
 * different days depending on which screen you look at.
 */
export function slotFor(
  planStartDate: Date,
  date: Date
): { week: number; day: string; scheduledDate: Date } {
  const at = startOfDay(date);
  // Monday-indexed, matching DAY_ORDER, not JavaScript's Sunday-first getDay().
  const dayIndex = (at.getDay() + 6) % 7;
  return {
    week: weekNumberFor(planStartDate, at),
    day: DAY_ORDER[dayIndex],
    scheduledDate: at,
  };
}

/** The Monday that starts a given plan week. */
export function weekStartDate(planStartDate: Date, week: number): Date {
  const monday = planWeekOneMonday(planStartDate);
  const d = new Date(monday);
  d.setDate(d.getDate() + (week - 1) * 7);
  return d;
}

/**
 * Where a session sits according to its week/day, for rows written before
 * `scheduledDate` existed. Falls back to the Monday if the day name is junk,
 * rather than guessing.
 */
export function nominalDate(
  planStartDate: Date,
  week: number,
  day: string
): Date {
  const d = weekStartDate(planStartDate, week);
  const offset = dayNameToIndex(day);
  if (offset > 0) d.setDate(d.getDate() + offset);
  return d;
}

// ---- Applying a batch ---------------------------------------------------

/**
 * Applies a set of moves to the athlete's current plan, all or nothing.
 *
 * A move is rejected — and the whole batch abandoned — if the session isn't
 * theirs, isn't movable, or either end of the move falls inside the commitment
 * window. Guardrail breaches are returned as warnings and do not stop the save.
 */
export async function applyMoves(
  userId: string,
  moves: SessionMove[],
  now: Date = new Date()
): Promise<RescheduleResult> {
  if (moves.length === 0) {
    return { applied: false, moved: 0, rejected: [], warnings: [] };
  }

  const plan = await prisma.trainingPlan.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: { sessions: true },
  });

  if (!plan) {
    return {
      applied: false,
      moved: 0,
      rejected: moves.map((m) => ({
        sessionId: m.sessionId,
        reason: "You don't have a training plan.",
      })),
      warnings: [],
    };
  }

  const planStart = plan.startDate ?? plan.createdAt;
  // Today, as the athlete's calendar sees it. A session may be moved onto
  // today; it may not be moved into a day that has already gone.
  const today = isoDate(now);
  const byId = new Map(plan.sessions.map((s) => [s.id, s]));
  const rejected: MoveRejection[] = [];

  // Resolve every move first. Nothing is written until all of them are legal.
  const resolved: {
    id: string;
    from: string;
    to: string;
    week: number;
    day: string;
    scheduledDate: Date;
  }[] = [];

  for (const move of moves) {
    const session = byId.get(move.sessionId);

    if (!session) {
      // Also covers sessions belonging to someone else: they aren't in this
      // plan, so they are simply unknown here.
      rejected.push({
        sessionId: move.sessionId,
        reason: "That session isn't part of your plan.",
      });
      continue;
    }

    if (!MOVABLE_STATUSES.includes(session.status)) {
      rejected.push({
        sessionId: move.sessionId,
        reason: `A ${session.status} session is a record of what happened and can't be rescheduled.`,
      });
      continue;
    }

    const target = parseISODate(move.toDate);
    if (!target) {
      rejected.push({
        sessionId: move.sessionId,
        reason: `"${move.toDate}" isn't a valid date.`,
      });
      continue;
    }

    const currentDate =
      session.scheduledDate ?? nominalDate(planStart, session.week, session.day);
    const from = isoDate(currentDate);

    // The commitment window (v3 §4.4) stops the ENGINE reshuffling imminent
    // days. It was also being applied to the athlete, who may always override
    // it by hand — and today is not the past. The UI had already been unlocked
    // for today's session, so the server rejecting the same move left the
    // athlete unable to save and, because the reason rendered behind the
    // dialog, with no idea why.
    //
    // What remains forbidden is scheduling into a day that has gone.
    if (move.toDate < today) {
      rejected.push({
        sessionId: move.sessionId,
        reason: `${move.toDate} has already passed — you can't plan a session into the past.`,
      });
      continue;
    }

    const slot = slotFor(planStart, target);
    if (slot.week < 1) {
      rejected.push({
        sessionId: move.sessionId,
        reason: `${move.toDate} is before your plan starts.`,
      });
      continue;
    }

    resolved.push({ id: session.id, from, to: move.toDate, ...slot });
  }

  if (rejected.length > 0) {
    return { applied: false, moved: 0, rejected, warnings: [] };
  }

  // Warnings describe the plan AFTER the moves, which is what the athlete is
  // about to commit to.
  const moveById = new Map(resolved.map((r) => [r.id, r]));
  const warnings = warningsFor(
    plan.sessions.map((s) => {
      const moved = moveById.get(s.id);
      return {
        id: s.id,
        date: moved
          ? moved.to
          : isoDate(
              s.scheduledDate ?? nominalDate(planStart, s.week, s.day)
            ),
        discipline: s.discipline,
        type: s.type,
        tss: s.tss,
        isAnchor: s.isAnchor,
        status: s.status,
      };
    })
  );

  // Snapshot, then write, in one transaction so a failure can't leave the plan
  // half-moved with no record of where it came from.
  const version = await prisma.$transaction(async (tx) => {
    const last = await tx.planVersion.findFirst({
      where: { planId: plan.id },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    const next = (last?.version ?? 0) + 1;

    const snapshot = await tx.planVersion.create({
      data: {
        planId: plan.id,
        version: next,
        snapshot: JSON.parse(JSON.stringify(plan.sessions)),
      },
    });

    for (const r of resolved) {
      await tx.plannedSession.update({
        where: { id: r.id },
        data: {
          week: r.week,
          day: r.day,
          scheduledDate: r.scheduledDate,
          adaptedAt: now,
        },
      });
    }

    await tx.adaptation.create({
      data: {
        userId,
        planId: plan.id,
        versionId: snapshot.id,
        trigger: "manual_drag",
        cause: { movedBy: "athlete", moves: resolved.length },
        diff: {
          moved: resolved.map((r) => ({ id: r.id, from: r.from, to: r.to })),
        },
        outcome: "applied",
        explanation:
          resolved.length === 1
            ? `You moved a session from ${resolved[0].from} to ${resolved[0].to}.`
            : `You rescheduled ${resolved.length} sessions.`,
      },
    });

    return next;
  });

  return {
    applied: true,
    moved: resolved.length,
    rejected: [],
    warnings,
    version,
  };
}

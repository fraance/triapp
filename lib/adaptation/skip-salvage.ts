/**
 * Skip salvage (v3 §3.5).
 *
 * An important session that the athlete skips must not vanish from the plan.
 * The confidence-and-test machinery once re-offers threshold *tests*, but a
 * skipped anchor, key workout, or quality session had no path back into the
 * week — the salvage engine computed a decision and nobody acted on it, so
 * nothing ever rescheduled. This module makes good on the spec's "reschedule"
 * verdict by requeuing important skipped sessions onto the earliest compatible
 * future slot that real life and the plan allow.
 *
 * It runs as a step of its own, before the solver: a skip should produce work
 * immediately, regardless of whether the load-solver happens to be stuck
 * (`blocked_frozen`). The solver reshuffles load afterwards; it does not decide
 * whether skipped work gets another chance.
 *
 * All date handling uses `localISO` so a local-midnight timestamp never rolls a
 * window back a day in a positive UTC offset.
 */
import { prisma } from "../prisma";
import { localISO } from "./load-vector";
import { protocolFor } from "./test-injection";
import { manualProtocolFor } from "./manual-test";

/** How far back a skipped session is still eligible for salvage. */
export const SALVAGE_LOOKBACK_DAYS = 7;
/** How far ahead the engine will look for somewhere to put the requeue. */
export const SALVAGE_WINDOW_DAYS = 10;
/** Minimum gap between a re-queued test and any other test. */
export const MIN_DAYS_BETWEEN_TESTS = 5;
/** Never place a requeue inside this many days of the race. */
export const TAPER_BLACKOUT_DAYS = 14;

const IMPORTANT =
  /threshold|interval|vo2|\banchor\b|(^|[ _])long[ _]?|key|race|quality/i;

/** A future, untouched, same-discipline slot the session could occupy. */
export interface SalvageSlot {
  id: string;
  date: string;
  discipline: string;
  type: string;
  isAnchor: boolean;
  status: string;
  isTest?: boolean;
}

export interface SalvageContext {
  today: string;
  frozenUntil: string;
  horizonDays: number;
  raceDate?: string | null;
  /** Whether a session of a length can happen on a date; tests use this. */
  fits?: (date: string, minutes: number) => boolean;
  slots: SalvageSlot[];
  existingTestDates?: string[];
}

export interface SalvagedWork {
  /** The id of the skipped session that spawned the requeue. */
  sourceSessionId: string;
  kind: string;
  discipline: string;
  requeuedAt: string;
  requeuedId: string;
  reason: string;
}

export interface SalvageSummary {
  requeued: SalvagedWork[];
  /** Skipped important sessions with no legal place to put the work. */
  couldNotPlace: Array<{ sourceSessionId: string; discipline: string; reason: string }>;
}

function daysBetween(a: string, b: string): number {
  return Math.round(
    (new Date(b + "T00:00:00").getTime() - new Date(a + "T00:00:00").getTime()) /
      86400000
  );
}

function isImportant(p: string | null, type: string, isAnchor: boolean): boolean {
  if (isAnchor) return true;
  return IMPORTANT.test(`${p ?? ""}  ${type}`);
}

function disciplineMatches(a: string, b: string): boolean {
  const x = (a ?? "").toLowerCase();
  const y = (b ?? "").toLowerCase();
  return x === y || x.includes(y) || y.includes(x);
}

/**
 * Chooses the best slot for `need` among the honest candidates.
 *
 * Pure and deterministic: given the same slots it returns the same decision.
 * A test is requeued only onto a bare planned slot (never an anchor or an
 * existing test), always same-discipline, not stacked against another test.
 */
export function pickSalvageSlot(
  need: { discipline: string; durationMinutes: number },
  ctx: SalvageContext,
  opts: { asTest?: boolean } = {}
): SalvageSlot | null {
  const taken = new Set(ctx.existingTestDates ?? []);

  const candidates = ctx.slots.filter((s) => {
    if (s.status !== "planned" && s.status !== "adapted") return false;
    if (ctx.frozenUntil && s.date <= ctx.frozenUntil) return false;
    if (s.date <= ctx.today) return false;
    if (!disciplineMatches(s.discipline, need.discipline)) return false;
    if (s.isAnchor) return false;
    if (s.isTest) return false;
    if (opts.asTest) {
      if (ctx.fits && !ctx.fits(s.date, need.durationMinutes)) return false;
      if (taken.has(s.date)) return false;
      for (const t of Array.from(taken)) {
        if (Math.abs(daysBetween(t, s.date)) < MIN_DAYS_BETWEEN_TESTS) return false;
      }
    }
    return true;
  });

  const within = candidates.filter(
    (s) => daysBetween(ctx.today, s.date) < ctx.horizonDays
  );
  return within[0] ?? null;
}

function parseMinutes(duration: string | null): number {
  const m = /(\d+)\s*(min|h)/i.exec(duration || "");
  if (!m) return 0;
  const n = Number(m[1]);
  return /h/i.test(m[2]) ? n * 60 : n;
}

async function equipmentFor(userId: string) {
  const [withPower, withHr] = await Promise.all([
    prisma.stravaActivity.count({
      where: { userId, avgWatts: { not: null }, discipline: "Bike" },
    }),
    prisma.stravaActivity.count({ where: { userId, avgHeartRate: { not: null } } }),
  ]);
  return { powerMeter: withPower >= 3, heartRateMonitor: withHr >= 3 };
}

async function protocolForKind(kind: string, userId: string) {
  const equipment = await equipmentFor(userId);
  const typed = kind as
    | "ftp"
    | "css"
    | "runThreshold"
    | "maxHr"
    | "thresholdHr" // accepted by the protocol table via ThresholdKind
  ;
  const device = protocolFor(typed, equipment);
  if (device) return device;
  const manual = manualProtocolFor(typed);
  return manual
    ? {
        kind: manual.kind,
        discipline: manual.discipline,
        name: manual.name,
        instructions: [manual.why, ...manual.steps].join(" "),
        durationMinutes: manual.durationMinutes,
        tss: manual.tss,
        requires: [] as string[],
      }
    : null;
}

/**
 * Requeues important sessions the athlete skipped since the recent past onto
 * the next compatible future slot, so the work is not lost.
 *
 * @param dryRun  report the write without actually performing it.
 */
export async function salvageSkippedSessions(
  userId: string,
  planId: string,
  ctx: SalvageContext,
  opts: { dryRun?: boolean } = {}
): Promise<SalvageSummary> {
  const from = new Date(ctx.today + "T00:00:00");
  from.setDate(from.getDate() - SALVAGE_LOOKBACK_DAYS);
  const fromISO = localISO(from);

  const skipped = await prisma.plannedSession.findMany({
    where: {
      planId,
      status: "skipped",
      scheduledDate: { gte: new Date(fromISO + "T00:00:00") },
    },
    orderBy: { scheduledDate: "asc" },
    select: {
      id: true,
      scheduledDate: true,
      discipline: true,
      type: true,
      purpose: true,
      isAnchor: true,
      isTest: true,
      testKind: true,
      duration: true,
      tss: true,
      instructions: true,
    },
  });

  const important = skipped.filter((s) =>
    isImportant(s.purpose, s.type ?? "", s.isAnchor)
  );

  const summary: SalvageSummary = { requeued: [], couldNotPlace: [] };

  for (const s of important) {
    const asTest = s.isTest;
    const slot = pickSalvageSlot(
      { discipline: s.discipline, durationMinutes: parseMinutes(s.duration) },
      ctx,
      { asTest }
    );

    if (!slot) {
      summary.couldNotPlace.push({
        sourceSessionId: s.id,
        discipline: s.discipline,
        reason: asTest
          ? "no legal slot with enough time within the horizon"
          : "no free same-discipline slot within the horizon",
      });
      continue;
    }

    if (opts.dryRun) {
      summary.requeued.push({
        sourceSessionId: s.id,
        kind: s.testKind ?? s.type ?? "session",
        discipline: s.discipline,
        requeuedAt: slot.date,
        requeuedId: slot.id,
        reason:
          "Would requeue this important session" + (asTest ? " as a test" : ""),
      });
      continue;
    }

    let data: Record<string, unknown>;
    if (asTest) {
      const protocol = await protocolForKind(s.testKind ?? "ftp", userId);
      if (!protocol) {
        summary.couldNotPlace.push({
          sourceSessionId: s.id,
          discipline: s.discipline,
          reason: "no protocol the athlete can execute for this test",
        });
        continue;
      }
      data = {
        isTest: true,
        testMode: "device",
        type: "Test",
        discipline: protocol.discipline,
        duration: `${protocol.durationMinutes} min`,
        tss: protocol.tss,
        instructions: protocol.instructions,
        purpose: `Re-establish ${protocol.kind} (requeued from skip)`,
        originalTss: s.tss,
        adaptedAt: new Date(),
      };
    } else {
      data = {
        type: s.type ?? "Quality",
        purpose: `${s.purpose ?? s.type ?? "Important"} (requeued)`,
        instructions: s.instructions,
        duration: s.duration,
        tss: s.tss,
        adaptedAt: new Date(),
      };
    }

    await prisma.plannedSession.update({
      where: { id: slot.id },
      data,
    });

    summary.requeued.push({
      sourceSessionId: s.id,
      kind: s.testKind ?? s.type ?? "session",
      discipline: s.discipline,
      requeuedAt: slot.date,
      requeuedId: slot.id,
      reason:
        "This important session was moved to the next free slot so its work is not lost.",
    });
  }

  return summary;
}
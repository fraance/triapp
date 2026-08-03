/**
 * Test injection (v3 §3.4: "triggered whenever threshold confidence drops
 * below 0.5").
 *
 * A threshold cannot be trusted forever, and asking the athlete to re-test on
 * a schedule they have to remember defeats the point of the product. The
 * engine schedules tests itself.
 *
 * Three things this is careful about:
 *
 *  - **Never prescribe a test the athlete cannot execute.** An FTP test is
 *    meaningless without a power meter, and a CSS test needs a pool. Where the
 *    equipment is absent we schedule the heart-rate equivalent instead, or
 *    nothing at all — never a protocol that produces a fabricated number.
 *  - **A test is a session, not extra load.** It replaces an existing quality
 *    session rather than being added on top, so injecting one cannot breach
 *    the weekly ramp.
 *  - **Never in race week or taper**, and never two tests close together.
 */
import { ThresholdKind, ThresholdConfidence } from "./physiology";

export interface TestProtocol {
  kind: ThresholdKind;
  discipline: string;
  /** What the athlete actually does. */
  name: string;
  instructions: string;
  durationMinutes: number;
  /** Roughly what it costs, so the week's load stays honest. */
  tss: number;
  /** Equipment this protocol requires. */
  requires: string[];
}

export interface EquipmentAvailable {
  powerMeter?: boolean;
  pool?: boolean;
  heartRateMonitor?: boolean;
}

/**
 * Protocols, in order of preference per threshold. The first one the athlete
 * has the equipment for is used.
 */
const PROTOCOLS: Record<string, TestProtocol[]> = {
  ftp: [
    {
      kind: "ftp",
      discipline: "Bike",
      name: "FTP test (20 min)",
      instructions:
        "20 min easy, 3x1 min fast spin-ups, 5 min easy, 5 min hard opener, " +
        "10 min easy, then 20 min ALL OUT at the hardest pace you can hold. " +
        "Cool down 10 min. Your FTP is 95% of the average power for the 20 min.",
      durationMinutes: 75,
      tss: 85,
      requires: ["powerMeter"],
    },
    {
      kind: "thresholdHr",
      discipline: "Bike",
      name: "Threshold HR test (20 min)",
      instructions:
        "Same 20 min all-out effort, but paced on feel. Your threshold heart " +
        "rate is the average HR over the final 20 min. Used instead of an FTP " +
        "test because you have no power meter.",
      durationMinutes: 75,
      tss: 85,
      requires: ["heartRateMonitor"],
    },
  ],
  css: [
    {
      kind: "css",
      discipline: "Swim",
      name: "CSS test (400m + 200m)",
      instructions:
        "Warm up 600m. Swim 400m as fast as you can hold, note the time. " +
        "Rest 5 min. Swim 200m all out, note the time. Cool down 200m. " +
        "CSS = (400 - 200) / (t400 - t200) seconds per 100m.",
      durationMinutes: 50,
      tss: 55,
      requires: ["pool"],
    },
  ],
  runThreshold: [
    {
      kind: "runThreshold",
      discipline: "Run",
      name: "Run threshold test (5 km time trial)",
      instructions:
        "Warm up 15 min easy with 4 strides. Then 5 km as fast as you can " +
        "hold, even pace, on flat ground. Cool down 10 min. Your threshold " +
        "pace is roughly your 5 km pace plus 15-20 sec/km.",
      durationMinutes: 55,
      tss: 75,
      requires: [],
    },
  ],
  maxHr: [
    {
      kind: "maxHr",
      discipline: "Run",
      name: "Max HR test (hill repeats)",
      instructions:
        "Warm up 15 min. Then 3x3 min uphill, hard, building to absolute " +
        "maximum on the last one. 3 min easy between. Your max HR is the " +
        "highest figure seen. Cool down 10 min.",
      durationMinutes: 50,
      tss: 70,
      requires: ["heartRateMonitor"],
    },
  ],
};

/** Picks the best protocol the athlete can actually execute. */
export function protocolFor(
  kind: ThresholdKind,
  equipment: EquipmentAvailable
): TestProtocol | null {
  const options = PROTOCOLS[kind] ?? [];
  for (const p of options) {
    const ok = p.requires.every((r) => (equipment as Record<string, boolean | undefined>)[r]);
    if (ok) return p;
  }
  return null;
}

export interface InjectionCandidate {
  kind: ThresholdKind;
  protocol: TestProtocol;
  confidence: number;
  /** The session this test should replace. */
  replaceSessionId: string;
  date: string;
  reason: string;
}

export interface PlanSlot {
  id: string;
  date: string;
  discipline: string;
  type: string;
  tss: number;
  durationMinutes: number;
  isAnchor: boolean;
  status: string;
  isTest?: boolean;
}

export interface InjectionContext {
  today: string;
  /** Sessions available to be replaced, in date order. */
  slots: PlanSlot[];
  equipment: EquipmentAvailable;
  /** Days on which a session of a given length can happen. */
  fits: (date: string, minutes: number) => boolean;
  /** ISO date of the A-race, so we never test into the taper. */
  raceDate?: string | null;
  /** Tests already scheduled or recently done, to avoid stacking them. */
  existingTestDates?: string[];
  /** Earliest date the engine may touch (commitment window). */
  frozenUntil?: string;
}

/** No testing inside this many days of the race — it is taper, not training. */
export const TAPER_BLACKOUT_DAYS = 14;
/** Minimum gap between two tests. */
export const MIN_DAYS_BETWEEN_TESTS = 5;

function daysBetween(a: string, b: string): number {
  return Math.round(
    (new Date(b + "T00:00:00").getTime() - new Date(a + "T00:00:00").getTime()) /
      86400000
  );
}

/**
 * Decides which tests to inject and where.
 *
 * Pure function: given confidences and the plan, it returns candidates. It does
 * not write anything, so the decision can be inspected and tested on its own.
 */
export function planTestInjections(
  confidences: ThresholdConfidence[],
  ctx: InjectionContext
): InjectionCandidate[] {
  const candidates: InjectionCandidate[] = [];
  const taken = [...(ctx.existingTestDates ?? [])];

  // Least trusted first — the number doing the most damage gets fixed soonest.
  const needing = confidences
    .filter((c) => c.needsTest)
    .sort((a, b) => a.confidence - b.confidence);

  for (const c of needing) {
    const protocol = protocolFor(c.kind, ctx.equipment);
    if (!protocol) continue; // cannot be tested honestly — skip, never fake it

    const slot = ctx.slots.find((s) => {
      if (s.isTest) return false;
      if (s.status !== "planned" && s.status !== "adapted") return false;
      if (ctx.frozenUntil && s.date <= ctx.frozenUntil) return false;
      if (s.date <= ctx.today) return false;
      // Same discipline, so the test replaces like with like.
      if (!s.discipline.toLowerCase().includes(protocol.discipline.toLowerCase()))
        return false;
      // Never sacrifice a key session to a test.
      if (s.isAnchor) return false;
      // The day must actually hold it.
      if (!ctx.fits(s.date, protocol.durationMinutes)) return false;
      // Not into the taper.
      if (ctx.raceDate && daysBetween(s.date, ctx.raceDate) < TAPER_BLACKOUT_DAYS)
        return false;
      // Not stacked against another test.
      if (taken.some((t) => Math.abs(daysBetween(t, s.date)) < MIN_DAYS_BETWEEN_TESTS))
        return false;
      return true;
    });

    if (!slot) continue;

    taken.push(slot.date);
    candidates.push({
      kind: c.kind,
      protocol,
      confidence: c.confidence,
      replaceSessionId: slot.id,
      date: slot.date,
      reason:
        `Confidence in your ${c.kind} has fallen to ` +
        `${Math.round(c.confidence * 100)}% (${c.basis}), so ${slot.discipline} ` +
        `on ${slot.date} becomes a test to re-establish it.`,
    });
  }

  return candidates;
}

/**
 * Capturing a threshold without the device that would normally measure it.
 *
 * The engine used to offer no test at all when the equipment was missing —
 * which meant the threshold decayed forever and the athlete was quietly moved
 * onto RPE with no way back. That is a dead end, not a decision.
 *
 * So every threshold gets two routes when the device is absent:
 *
 *   1. **Capture it by hand.** A genuine field protocol needing only a
 *      stopwatch, a pool clock, or a measured track — plus the arithmetic done
 *      for them, so they enter what they can actually observe (two swim
 *      times), never a number they'd have to compute themselves.
 *   2. **Skip it.** Recorded, and not offered again for a cooling-off period.
 *      Re-asking every day is exactly the interrogation v3's North Star
 *      forbids.
 *
 * The athlete enters raw observations. We do the conversion, and we refuse the
 * result if it is implausible rather than storing a number that will silently
 * drive every session after it.
 */
import { ThresholdKind } from "./physiology";

export interface ManualField {
  key: string;
  label: string;
  /** "seconds" accepts mm:ss or a plain number of seconds. */
  unit: "seconds" | "number";
  hint?: string;
}

export interface ManualProtocol {
  kind: ThresholdKind;
  discipline: string;
  name: string;
  /** Why the athlete is being asked to do this by hand. */
  why: string;
  /** Step-by-step, assuming no special equipment. */
  steps: string[];
  /** What they type in afterwards. */
  fields: ManualField[];
  durationMinutes: number;
  tss: number;
}

export const MANUAL_PROTOCOLS: Record<string, ManualProtocol> = {
  css: {
    kind: "css",
    discipline: "Swim",
    name: "Swim CSS test — timed by hand",
    why:
      "Your watch does not report the 400 m and 200 m splits a CSS test needs, " +
      "so time them yourself. A poolside clock or a phone on the wall is enough.",
    steps: [
      "Warm up 600 m easy, mixed strokes.",
      "Swim 400 m as fast as you can hold evenly. Note the time.",
      "Rest 5 minutes, easy floating.",
      "Swim 200 m all out. Note the time.",
      "Cool down 200 m easy.",
      "Enter both times below — we work out your CSS from them.",
    ],
    fields: [
      { key: "t400", label: "400 m time", unit: "seconds", hint: "e.g. 7:20" },
      { key: "t200", label: "200 m time", unit: "seconds", hint: "e.g. 3:25" },
    ],
    durationMinutes: 50,
    tss: 55,
  },

  ftp: {
    kind: "ftp",
    discipline: "Bike",
    name: "FTP test — on any bike that shows power",
    why:
      "You have no power meter of your own. Any gym spin bike, smart trainer " +
      "or borrowed bike that displays watts will do for this.",
    steps: [
      "Warm up 20 minutes easy, with 3 × 1 minute fast spin-ups.",
      "5 minutes easy, then a 5 minute hard opener, then 10 minutes easy.",
      "20 minutes ALL OUT — the hardest effort you can hold to the end.",
      "Cool down 10 minutes.",
      "Enter the average power for those 20 minutes. We take 95% of it as your FTP.",
    ],
    fields: [
      { key: "avgWatts", label: "Average watts over the 20 minutes", unit: "number" },
    ],
    durationMinutes: 75,
    tss: 85,
  },

  runThreshold: {
    kind: "runThreshold",
    discipline: "Run",
    name: "Run threshold test — timed 5 km",
    why:
      "No GPS watch needed. Any measured 5 km works — an athletics track is " +
      "12.5 laps in lane one.",
    steps: [
      "Warm up 15 minutes easy, then 4 × 20 second strides.",
      "Run 5 km as fast as you can hold, even pace, on flat ground.",
      "Cool down 10 minutes easy.",
      "Enter your finish time. Threshold pace is roughly 17 sec/km slower.",
    ],
    fields: [
      { key: "time5k", label: "5 km time", unit: "seconds", hint: "e.g. 27:57" },
    ],
    durationMinutes: 55,
    tss: 75,
  },

  maxHr: {
    kind: "maxHr",
    discipline: "Run",
    name: "Max heart rate — taken by hand",
    why:
      "Without a heart rate strap you can still take this yourself, straight " +
      "after the hardest effort.",
    steps: [
      "Warm up 15 minutes.",
      "3 × 3 minutes uphill, hard, building to absolute maximum on the last.",
      "The instant you stop the final rep, find your pulse at the wrist or neck.",
      "Count the beats for 15 seconds and multiply by 4.",
      "Enter that figure. Take it within 10 seconds of stopping — it falls fast.",
    ],
    fields: [
      { key: "bpm", label: "Highest heart rate (beats per minute)", unit: "number" },
    ],
    durationMinutes: 50,
    tss: 70,
  },

  thresholdHr: {
    kind: "thresholdHr",
    discipline: "Bike",
    name: "Threshold heart rate — taken by hand",
    why: "No chest strap needed; you take your own pulse at the end of the effort.",
    steps: [
      "Warm up 20 minutes easy.",
      "20 minutes ALL OUT at the hardest effort you can sustain.",
      "The moment you finish, take your pulse for 15 seconds and multiply by 4.",
      "Cool down 10 minutes.",
      "Enter that figure as your threshold heart rate.",
    ],
    fields: [
      { key: "bpm", label: "Heart rate at the end of the effort", unit: "number" },
    ],
    durationMinutes: 55,
    tss: 80,
  },
};

export function manualProtocolFor(kind: ThresholdKind): ManualProtocol | null {
  return MANUAL_PROTOCOLS[kind] ?? null;
}

// ---- Converting what they observed into a threshold ----------------------

export interface ManualResult {
  value: number;
  method: string;
}

export interface ManualError {
  error: string;
}

/** Accepts "7:20", "440", 440. Returns seconds, or null if unusable. */
export function parseSeconds(input: unknown): number | null {
  if (typeof input === "number" && Number.isFinite(input)) return input;
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  const m = /^(\d+):([0-5]?\d)(\.\d+)?$/.exec(trimmed);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number(m[3]) : 0);
}

function num(input: unknown): number | null {
  const n = typeof input === "string" ? Number(input.trim()) : input;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/**
 * Turns the athlete's observations into a threshold.
 *
 * Every branch validates plausibility. A mistyped digit that silently becomes
 * a threshold would corrupt every session that follows, and the athlete would
 * have no way of knowing.
 */
export function computeManualThreshold(
  kind: ThresholdKind,
  inputs: Record<string, unknown>
): ManualResult | ManualError {
  switch (kind) {
    case "css": {
      const t400 = parseSeconds(inputs.t400);
      const t200 = parseSeconds(inputs.t200);
      if (t400 == null || t200 == null) {
        return { error: "Enter both the 400 m and 200 m times." };
      }
      if (t400 <= t200) {
        return {
          error:
            "The 400 m time must be longer than the 200 m time — check they " +
            "have not been entered the other way round.",
        };
      }
      // CSS = (400 - 200) / (t400 - t200), expressed per 100 m.
      const css = ((t400 - t200) / 200) * 100;
      if (css < 45 || css > 240) {
        return { error: `That works out at ${Math.round(css)} sec/100 m, which is outside any plausible range. Please check the times.` };
      }
      return {
        value: Math.round(css),
        method: `(400−200) ÷ (${Math.round(t400)}s − ${Math.round(t200)}s), per 100 m`,
      };
    }

    case "ftp": {
      const watts = num(inputs.avgWatts);
      if (watts == null) return { error: "Enter the average watts for the 20 minutes." };
      const ftp = Math.round(watts * 0.95);
      if (ftp < 50 || ftp > 600) {
        return { error: `${ftp} W is outside any plausible range. Please check the figure.` };
      }
      return { value: ftp, method: `95% of ${Math.round(watts)} W held for 20 minutes` };
    }

    case "runThreshold": {
      const t = parseSeconds(inputs.time5k);
      if (t == null) return { error: "Enter your 5 km time." };
      if (t < 720 || t > 3600) {
        return { error: "That 5 km time is outside any plausible range. Please check it." };
      }
      const value = Math.round(t / 5 + 17);
      return {
        value,
        method: `5 km in ${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, "0")}, plus 17 sec/km`,
      };
    }

    case "maxHr":
    case "thresholdHr": {
      const bpm = num(inputs.bpm);
      if (bpm == null) return { error: "Enter the heart rate you counted." };
      const min = kind === "maxHr" ? 120 : 100;
      const max = kind === "maxHr" ? 230 : 220;
      if (bpm < min || bpm > max) {
        return { error: `${Math.round(bpm)} bpm is outside any plausible range. Please check it.` };
      }
      return {
        value: Math.round(bpm),
        method: "counted by hand immediately after the effort",
      };
    }

    default:
      return { error: "That threshold cannot be captured by hand." };
  }
}

export function isManualError(r: ManualResult | ManualError): r is ManualError {
  return (r as ManualError).error !== undefined;
}

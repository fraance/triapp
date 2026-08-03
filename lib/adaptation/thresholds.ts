/**
 * The threshold lifecycle: manual baseline → scheduled test → automatic update.
 *
 * The problem this solves: a threshold is only as good as the day it was
 * established. Training to an FTP set five months ago produces confident,
 * precise, wrong targets — and the engine had no way to know, because
 * `profile.updatedAt` moves whenever anything on the profile is written.
 *
 * `AthleteProfile.thresholdsMeasuredAt` now records, per threshold, *when* it
 * was established and *how*:
 *
 *   manual   the athlete told us — trusted completely, dated from that moment
 *   test     a test the engine scheduled and the athlete completed
 *   derived  inferred from ordinary training — real evidence, but weaker
 *
 * Everything downstream (confidence decay, RPE fallback, test injection) reads
 * these dates rather than guessing.
 */
import { prisma } from "../prisma";
import { ThresholdKind } from "./physiology";

export type MeasurementSource = "manual" | "test" | "derived";

export interface ThresholdMeasurement {
  at: string; // ISO timestamp
  source: MeasurementSource;
  /** The value recorded at that moment, for an audit trail. */
  value?: number | null;
}

export type ThresholdRecord = Partial<Record<ThresholdKind, ThresholdMeasurement>>;

/** How much a source is trusted when confidence decays from it. */
export const SOURCE_STRENGTH: Record<MeasurementSource, number> = {
  manual: 1,
  test: 1,
  derived: 0.75,
};

/** Profile columns each threshold lives in. */
export const THRESHOLD_FIELDS: Record<ThresholdKind, string> = {
  ftp: "ftpWatts",
  css: "swimCssSecPer100",
  runThreshold: "runThresholdPaceSec",
  maxHr: "maxHeartRate",
  thresholdHr: "thresholdHeartRate",
};

export function parseRecord(raw: unknown): ThresholdRecord {
  if (!raw || typeof raw !== "object") return {};
  const out: ThresholdRecord = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const entry = v as Record<string, unknown>;
    if (typeof entry.at !== "string") continue;
    const source = entry.source;
    out[k as ThresholdKind] = {
      at: entry.at,
      source:
        source === "manual" || source === "test" || source === "derived"
          ? source
          : "derived",
      value: typeof entry.value === "number" ? entry.value : null,
    };
  }
  return out;
}

export async function getThresholdRecord(userId: string): Promise<ThresholdRecord> {
  const p = await prisma.athleteProfile.findUnique({
    where: { userId },
    select: { thresholdsMeasuredAt: true },
  });
  return parseRecord(p?.thresholdsMeasuredAt);
}

/**
 * Records that a threshold was established, and stores the value itself.
 *
 * This is the single write path for all three routes — manual entry, a
 * completed test, and derivation from training — so a value can never end up
 * in the profile without a date and a provenance beside it.
 */
export async function recordThreshold(
  userId: string,
  kind: ThresholdKind,
  value: number | null,
  source: MeasurementSource,
  at: Date = new Date()
): Promise<void> {
  const field = THRESHOLD_FIELDS[kind];
  if (!field) return;

  const existing = await getThresholdRecord(userId);

  // Clearing a threshold must clear its provenance too, and must pass null —
  // Prisma reads undefined as "leave unchanged", which would strand a stale
  // date beside an empty value.
  const next: ThresholdRecord = { ...existing };
  if (value == null) {
    delete next[kind];
  } else {
    next[kind] = { at: at.toISOString(), source, value };
  }

  await prisma.athleteProfile.upsert({
    where: { userId },
    create: {
      userId,
      [field]: value,
      thresholdsMeasuredAt: next as object,
    } as never,
    update: {
      [field]: value,
      thresholdsMeasuredAt: next as object,
    } as never,
  });
}

/**
 * Records several thresholds at once — used by the manual-entry path, where an
 * athlete typically fills in more than one field in a single save.
 *
 * Only values that actually changed are re-dated. Re-saving a profile without
 * touching the numbers must not refresh their dates: that would let a
 * five-month-old FTP look freshly measured because someone edited their
 * postcode.
 */
export async function recordManualThresholds(
  userId: string,
  values: Partial<Record<ThresholdKind, number | null>>,
  at: Date = new Date()
): Promise<ThresholdKind[]> {
  const profile = await prisma.athleteProfile.findUnique({ where: { userId } });
  const existing = parseRecord(profile?.thresholdsMeasuredAt);
  const changed: ThresholdKind[] = [];

  for (const [kind, value] of Object.entries(values) as Array<
    [ThresholdKind, number | null | undefined]
  >) {
    if (value === undefined) continue;
    const field = THRESHOLD_FIELDS[kind];
    const current = profile ? (profile as never as Record<string, unknown>)[field] : null;
    const currentNum = typeof current === "number" ? current : null;
    if (currentNum === value) continue; // unchanged — do not re-date it
    changed.push(kind);
    await recordThreshold(userId, kind, value, "manual", at);
  }

  return changed;
}

/**
 * Observation list for the confidence model.
 *
 * A recorded measurement is the anchor. Ordinary training corroborates it
 * weakly. A threshold with no recorded date has no anchor at all and is
 * treated as untrusted, which is the honest position.
 */
export function observationsFor(
  kind: ThresholdKind,
  record: ThresholdRecord,
  trainingDates: Date[]
): Array<{ at: Date; strength: number }> {
  const out: Array<{ at: Date; strength: number }> = [];
  const measured = record[kind];
  if (measured) {
    out.push({
      at: new Date(measured.at),
      strength: SOURCE_STRENGTH[measured.source],
    });
  }
  for (const d of trainingDates) out.push({ at: d, strength: 0.5 });
  return out;
}

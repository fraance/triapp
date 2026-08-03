/**
 * Dates the thresholds that already exist but were never recorded.
 *
 * These values were derived by `athlete-metrics` from Strava data, but until
 * `thresholdsMeasuredAt` existed there was nowhere to record *when*. Without a
 * date, confidence decay has no anchor and the engine treats a perfectly good
 * number as untrusted.
 *
 * They are recorded as **derived**, not manual: they came from ordinary
 * training, not from a test or the athlete's own statement, and the source
 * strength reflects that. The date used is the most recent activity in the
 * relevant discipline — the newest evidence that could have produced the value.
 *
 * Never overwrites an existing record, so a manual entry or a completed test
 * always wins.
 *
 * Run with: npx tsx scripts/backfill-threshold-dates.mts <email> [--apply]
 */
import "../tests/env.mts";
import { prisma } from "../lib/prisma";
import { getThresholdRecord, recordThreshold } from "../lib/adaptation/thresholds";
import { normaliseDiscipline } from "../lib/adaptation/load-vector";
import type { ThresholdKind } from "../lib/adaptation/physiology";

const SOURCES: Array<{ kind: ThresholdKind; field: string; discipline: string | "hr" }> = [
  { kind: "ftp", field: "ftpWatts", discipline: "bike" },
  { kind: "css", field: "swimCssSecPer100", discipline: "swim" },
  { kind: "runThreshold", field: "runThresholdPaceSec", discipline: "run" },
  { kind: "maxHr", field: "maxHeartRate", discipline: "hr" },
  { kind: "thresholdHr", field: "thresholdHeartRate", discipline: "hr" },
];

async function main() {
  const email = process.argv[2];
  const apply = process.argv.includes("--apply");
  if (!email) {
    console.error("usage: tsx scripts/backfill-threshold-dates.mts <email> [--apply]");
    process.exit(1);
  }

  const user = await prisma.user.findFirst({ where: { email }, select: { id: true } });
  if (!user) {
    console.error(`no account for ${email}`);
    process.exit(1);
  }

  const profile = await prisma.athleteProfile.findUnique({ where: { userId: user.id } });
  if (!profile) {
    console.log("no profile — nothing to date");
    await prisma.$disconnect();
    return;
  }

  const existing = await getThresholdRecord(user.id);
  const activities = await prisma.stravaActivity.findMany({
    where: { userId: user.id },
    orderBy: { startDate: "desc" },
    select: { startDate: true, discipline: true, avgHeartRate: true },
  });

  for (const s of SOURCES) {
    const value = (profile as never as Record<string, unknown>)[s.field];
    if (typeof value !== "number" || value <= 0) continue;
    if (existing[s.kind]) {
      console.log(`  ${s.kind}: already recorded (${existing[s.kind]!.source}) — left alone`);
      continue;
    }

    const newest =
      s.discipline === "hr"
        ? activities.find((a) => a.avgHeartRate != null)
        : activities.find((a) => normaliseDiscipline(a.discipline) === s.discipline);

    if (!newest) {
      console.log(`  ${s.kind}: no supporting activity — left undated, so it stays untrusted`);
      continue;
    }

    console.log(
      `  ${s.kind} = ${value}  ->  derived, dated ${newest.startDate.toDateString()}`
    );
    if (apply) {
      await recordThreshold(user.id, s.kind, value, "derived", newest.startDate);
    }
  }

  console.log(apply ? "\nrecorded" : "\ndry run — re-run with --apply");
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});

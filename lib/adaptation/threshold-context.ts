/**
 * Turns threshold confidence into instructions the coach can act on
 * (v3 §2.1, §3.4).
 *
 * The point is not to display a percentage. It is to stop the coach
 * prescribing precise watts and paces from a number nobody has re-established
 * in months — which reads authoritative and is simply wrong.
 */
import { prisma } from "../prisma";
import { normaliseDiscipline } from "./load-vector";
import {
  thresholdConfidence,
  buildThresholdReport,
  ThresholdConfidence,
} from "./physiology";

const LABELS: Record<string, string> = {
  ftp: "FTP",
  css: "swim CSS",
  runThreshold: "run threshold pace",
  maxHr: "max heart rate",
  thresholdHr: "threshold heart rate",
};

export async function thresholdReportForPrompt(
  userId: string,
  now: Date = new Date()
): Promise<string | null> {
  const [profile, activities] = await Promise.all([
    prisma.athleteProfile.findUnique({
      where: { userId },
      select: {
        ftpWatts: true,
        swimCssSecPer100: true,
        runThresholdPaceSec: true,
        maxHeartRate: true,
        thresholdHeartRate: true,
      },
    }),
    prisma.stravaActivity.findMany({
      where: { userId, startDate: { gte: new Date(now.getTime() - 180 * 86400000) } },
      select: { startDate: true, discipline: true, avgHeartRate: true },
    }),
  ]);

  if (!profile) return null;

  const forDiscipline = (d: string, strength = 0.75) =>
    activities
      .filter((a) => normaliseDiscipline(a.discipline) === d)
      .map((a) => ({ at: a.startDate, strength }));

  const hr = activities
    .filter((a) => a.avgHeartRate != null)
    .map((a) => ({ at: a.startDate, strength: 0.5 }));

  const entries: ThresholdConfidence[] = [
    thresholdConfidence("ftp", profile.ftpWatts, forDiscipline("bike"), now),
    thresholdConfidence("css", profile.swimCssSecPer100, forDiscipline("swim"), now),
    thresholdConfidence(
      "runThreshold",
      profile.runThresholdPaceSec,
      forDiscipline("run"),
      now
    ),
    thresholdConfidence("maxHr", profile.maxHeartRate, hr, now),
    thresholdConfidence("thresholdHr", profile.thresholdHeartRate, hr, now),
  ];

  const report = buildThresholdReport(entries);
  const known = entries.filter((e) => e.value != null);
  if (known.length === 0) return null;

  const lines = ["THRESHOLD CONFIDENCE (how much to trust these numbers):"];
  for (const e of known) {
    lines.push(
      `- ${LABELS[e.kind] ?? e.kind}: ${Math.round(e.confidence * 100)}% confident ` +
        `(${e.basis})`
    );
  }

  if (report.rpeOnly.length > 0) {
    lines.push(
      `- Prescribe ${report.rpeOnly
        .map((k) => LABELS[k] ?? k)
        .join(" and ")} in RPE or by feel, NOT in numbers — the stored value is ` +
        `too old to be trusted.`
    );
  }
  if (report.testsNeeded.length > 0) {
    const testable = report.testsNeeded.filter((k) =>
      known.some((e) => e.kind === k)
    );
    if (testable.length > 0) {
      lines.push(
        `- Schedule a test to re-establish ${testable
          .map((k) => LABELS[k] ?? k)
          .join(" and ")}.`
      );
    }
  }
  if (report.rpeOnly.length === 0 && report.testsNeeded.length === 0) {
    lines.push("- All thresholds are recent enough to prescribe from directly.");
  }

  return lines.join("\n");
}

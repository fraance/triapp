import "../tests/env.mts";
import { prisma } from "../lib/prisma";

// One-off health repair: collapse exact-duplicate sessions (same week, day,
// discipline, type) that a past generation wrote twice onto the same date.
// Keeps the earliest-created row; deletes the extras. Rows that carry evidence
// of what the athlete actually did (a source activity, or a completed/
// unplanned/substituted status) are never touched.
//
// Usage:            npx tsx scripts/_repair-dupes.mts <userId>
// Preview (no-write): DRY_RUN=1 npx tsx scripts/_repair-dupes.mts <userId>

const userId = process.argv[2];
const dry = process.env.DRY_RUN === "1";
if (!userId) {
  console.error("usage: npx tsx scripts/_repair-dupes.mts <userId>");
  process.exit(1);
}

async function main() {
  const plans = await prisma.trainingPlan.findMany({
    where: { userId },
    select: { id: true },
  });
  if (plans.length === 0) {
    console.log("No plan for this user.");
    return;
  }

  let deleted = 0;
  let groups = 0;

  for (const plan of plans) {
    const rows = await prisma.plannedSession.findMany({
      where: { planId: plan.id },
    });

    const by = new Map<string, typeof rows>();
    for (const r of rows) {
      const key = `${r.week}|${r.day}|${r.discipline}|${r.type}`;
      by.set(key, [...(by.get(key) ?? []), r]);
    }

    for (const [key, group] of by) {
      if (group.length <= 1) continue;

      // Rule: only collapse if none of the group carries evidence of real work
      // (a reconciled source activity, or a judgement about what happened).
      const untouched = group.every(
        (r) =>
          !r.sourceActivityId &&
          r.status !== "completed" &&
          r.status !== "unplanned" &&
          r.status !== "substituted"
      );
      if (!untouched) {
        console.log(`  keep all (evidence present)   ${key} ×${group.length}`);
        continue;
      }

      // Keep the earliest-created row (tie-break by id for determinism).
      group.sort((a, b) =>
        (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0) ||
        a.id.localeCompare(b.id)
      );
      const [keep, ...drop] = group;
      groups++;
      console.log(`  keep ${keep.id} (${keep.type}, tss=${keep.tss}) ${key} + drop ×${drop.length}`);
      for (const d of drop) {
        deleted++;
        if (!dry) await prisma.plannedSession.delete({ where: { id: d.id } });
      }
    }
  }

  console.log(
    dry
      ? `\n[dry run] would delete ${deleted} duplicate rows across ${groups} group(s).`
      : `\nDeleted ${deleted} duplicate row(s) across ${groups} group(s).`
  );
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
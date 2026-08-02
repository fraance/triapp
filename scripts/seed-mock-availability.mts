/**
 * Seeds a PLACEHOLDER availability profile.
 *
 * ⚠️ This is mock data, injected at the CEO's explicit request so the §4.3
 * constraint logic could be proven while he was offline. It is NOT his real
 * declared availability.
 *
 * It is deliberately:
 *   - a script you must run on purpose, never automatic;
 *   - tagged in `constraints` with a MOCK marker, so it can never quietly
 *     masquerade as something the athlete actually told us (project rule 2);
 *   - reversible with `--clear`, which RESTORES whatever the athlete had
 *     declared before. His real declaration ("no time constraints", long
 *     session on Saturday) is captured verbatim in the marker so nothing is
 *     lost. Overwriting a real declaration with a placeholder would otherwise
 *     be exactly the kind of invented data project rule 2 forbids.
 *
 * Profile: Mon–Thu 1h, Fri 0h, Sat 3h, Sun 4h.
 *
 * Run with:
 *   npx tsx scripts/seed-mock-availability.mts <email>
 *   npx tsx scripts/seed-mock-availability.mts <email> --clear
 */
import "../tests/env.mts";
import { prisma } from "../lib/prisma";

export const MOCK_MARKER = "[MOCK PLACEHOLDER — not athlete-declared]";

export const MOCK_PROFILE = {
  monHours: 1,
  tueHours: 1,
  wedHours: 1,
  thuHours: 1,
  friHours: 0,
  satHours: 3,
  sunHours: 4,
  noTimeConstraints: false,
  longSessionDay: "Sunday",
};

/** Recovers the athlete's original declaration from the mock marker. */
function restorePayload(constraints: string): Record<string, unknown> | null {
  const at = constraints.indexOf("previous=");
  if (at < 0) return null;
  try {
    return JSON.parse(constraints.slice(at + "previous=".length));
  } catch {
    return null;
  }
}

async function main() {
  const email = process.argv[2];
  const clear = process.argv.includes("--clear");

  if (!email) {
    console.error("usage: tsx scripts/seed-mock-availability.mts <email> [--clear]");
    process.exit(1);
  }

  const user = await prisma.user.findFirst({ where: { email }, select: { id: true } });
  if (!user) {
    console.error(`no account for ${email}`);
    process.exit(1);
  }

  if (clear) {
    const existing = await prisma.trainingAvailability.findUnique({
      where: { userId: user.id },
      select: { constraints: true },
    });
    if (!existing?.constraints?.includes(MOCK_MARKER)) {
      console.error(
        "refusing to clear: this availability is not tagged as mock, so it may be real."
      );
      process.exit(1);
    }

    const saved = restorePayload(existing.constraints ?? "");
    if (saved) {
      await prisma.trainingAvailability.update({
        where: { userId: user.id },
        data: { ...saved },
      });
      console.log(`restored the athlete's original declared availability for ${email}`);
    } else {
      await prisma.trainingAvailability.delete({ where: { userId: user.id } });
      console.log(`removed the mock availability for ${email}`);
    }
    await prisma.$disconnect();
    return;
  }

  const existing = await prisma.trainingAvailability.findUnique({
    where: { userId: user.id },
  });

  const alreadyMock = existing?.constraints?.includes(MOCK_MARKER) ?? false;
  if (existing && !alreadyMock && !process.argv.includes("--force")) {
    console.error(
      "This athlete has already declared availability:\n" +
        `  noTimeConstraints=${existing.noTimeConstraints}, ` +
        `longSessionDay=${existing.longSessionDay ?? "-"}\n` +
        "Refusing to replace real data with a placeholder. Re-run with --force " +
        "to proceed; the original will be saved and restored by --clear."
    );
    process.exit(1);
  }

  // Preserve whatever was there so --clear can put it back exactly.
  const marker = existing && !alreadyMock
    ? `${MOCK_MARKER} previous=${JSON.stringify({
        noTimeConstraints: existing.noTimeConstraints,
        monHours: existing.monHours, tueHours: existing.tueHours,
        wedHours: existing.wedHours, thuHours: existing.thuHours,
        friHours: existing.friHours, satHours: existing.satHours,
        sunHours: existing.sunHours,
        longSessionDay: existing.longSessionDay,
        constraints: existing.constraints,
      })}`
    : (existing?.constraints ?? MOCK_MARKER);

  await prisma.trainingAvailability.upsert({
    where: { userId: user.id },
    create: { userId: user.id, ...MOCK_PROFILE, constraints: marker },
    update: { ...MOCK_PROFILE, constraints: marker },
  });

  console.log(`seeded MOCK availability for ${email}:`);
  console.log("  Mon-Thu 1h, Fri 0h, Sat 3h, Sun 4h; long session on Sunday");
  console.log(`  tagged: ${MOCK_MARKER}`);
  console.log("  remove with: npx tsx scripts/seed-mock-availability.mts <email> --clear");

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});

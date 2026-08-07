/**
 * The coach chat's ability to move or swap a session on request.
 *
 * These tests never call OpenAI (matching the rest of the coach-chat suite):
 * they exercise the deterministic pieces directly — the validation that
 * guards against a hallucinated token or date, and the actual move/swap via
 * `resolveScheduleAction`, which is the same guardrail-checked `applyMoves`
 * path the calendar's drag-and-drop uses.
 *
 * Run with:  npm run test:schedule-intent
 */
import "./env.mts";
import {
  validateScheduleAction,
  parseScheduleRequest,
  ScheduleSession,
} from "../lib/adaptation/schedule-intent";
import { resolveScheduleAction } from "../lib/adaptation/coach-chat";
import { createUser, saveFullPlan } from "../lib/db";
import { isoDate } from "../lib/reschedule";
import { prisma } from "../lib/prisma";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? ` — ${detail}` : ""}`);
  }
}

const SESSIONS: ScheduleSession[] = [
  { token: "S1", date: "2026-08-11", day: "Tuesday", discipline: "Run", type: "Intervals", isAnchor: false },
  { token: "S2", date: "2026-08-13", day: "Thursday", discipline: "Swim", type: "Drills", isAnchor: false },
  { token: "S3", date: "2026-08-15", day: "Saturday", discipline: "Bike", type: "Long", isAnchor: true },
];

async function main() {
  console.log("\nTriApp — coach chat schedule requests\n");

  console.log("The model's output is never trusted blindly:");
  check(
    "a valid move is accepted",
    validateScheduleAction({ kind: "move", sessionToken: "S1", toDate: "2026-08-14" }, SESSIONS).kind === "move"
  );
  check(
    "a hallucinated token is rejected",
    validateScheduleAction({ kind: "move", sessionToken: "S99", toDate: "2026-08-14" }, SESSIONS).kind === "none"
  );
  check(
    "an invalid date is rejected",
    validateScheduleAction({ kind: "move", sessionToken: "S1", toDate: "not a date" }, SESSIONS).kind === "none"
  );
  check(
    "a move with no date at all is rejected",
    validateScheduleAction({ kind: "move", sessionToken: "S1", toDate: null }, SESSIONS).kind === "none"
  );
  check(
    "a valid swap is accepted",
    validateScheduleAction({ kind: "swap", sessionToken: "S1", otherToken: "S2" }, SESSIONS).kind === "swap"
  );
  check(
    "swapping a session with itself is rejected",
    validateScheduleAction({ kind: "swap", sessionToken: "S1", otherToken: "S1" }, SESSIONS).kind === "none"
  );
  check(
    "swapping with a hallucinated token is rejected",
    validateScheduleAction({ kind: "swap", sessionToken: "S1", otherToken: "S99" }, SESSIONS).kind === "none"
  );
  check(
    "garbage input yields none, not a crash",
    validateScheduleAction(null, SESSIONS).kind === "none" &&
      validateScheduleAction("nonsense", SESSIONS).kind === "none" &&
      validateScheduleAction({}, SESSIONS).kind === "none"
  );
  check(
    "kind \"none\" from the model is passed straight through",
    validateScheduleAction({ kind: "none" }, SESSIONS).kind === "none"
  );

  console.log("\nThe parser never calls out for nothing:");
  const empty1 = await parseScheduleRequest("", "2026-08-10", SESSIONS);
  check("empty text short-circuits without a request", empty1.kind === "none");
  const empty2 = await parseScheduleRequest("move my run", "2026-08-10", []);
  check("no sessions to reference short-circuits without a request", empty2.kind === "none");

  console.log("\nA recognized move actually moves the session:");
  const user = await createUser(`schedule-intent-${Date.now()}@test.local`, "pw-test-1234");

  try {
    const start = new Date("2026-08-10T00:00:00"); // a Monday
    await saveFullPlan(
      user.id,
      new Date("2026-09-12T00:00:00"),
      [
        {
          week: 1, phase: "Build",
          sessions: [
            { day: "Tuesday", discipline: "Run", type: "Intervals", duration: "40 min", tss: 60 },
            { day: "Thursday", discipline: "Swim", type: "Drills", duration: "45 min", tss: 40 },
          ],
        },
      ],
      start,
      [{ week: 1, phase: "Build" }]
    );

    const plan = await prisma.trainingPlan.findFirst({ where: { userId: user.id } });
    const rows = await prisma.plannedSession.findMany({ where: { planId: plan!.id }, orderBy: { scheduledDate: "asc" } });
    const run = rows.find((r) => r.discipline === "Run")!;
    const swim = rows.find((r) => r.discipline === "Swim")!;

    const tokenToSession = new Map([
      ["S1", { id: run.id, discipline: run.discipline, type: run.type, date: "2026-08-11" }],
      ["S2", { id: swim.id, discipline: swim.discipline, type: swim.type, date: "2026-08-13" }],
    ]);

    const moveOutcome = await resolveScheduleAction(
      user.id,
      { kind: "move", sessionToken: "S1", toDate: "2026-08-14", otherToken: null },
      tokenToSession,
      new Date("2026-08-10T09:00:00"),
      false
    );
    check("the move is reported as applied", moveOutcome.applied, JSON.stringify(moveOutcome));
    check("the change describes the right session", moveOutcome.changes[0]?.discipline === "Run");

    const movedRun = await prisma.plannedSession.findUnique({ where: { id: run.id } });
    check(
      "the session's date actually changed in the database",
      movedRun?.scheduledDate && isoDate(movedRun.scheduledDate) === "2026-08-14",
      movedRun?.scheduledDate ? isoDate(movedRun.scheduledDate) : "null"
    );

    console.log("\nA swap trades both dates atomically:");
    const swapOutcome = await resolveScheduleAction(
      user.id,
      { kind: "swap", sessionToken: "S1", otherToken: "S2", toDate: null },
      tokenToSession,
      new Date("2026-08-10T09:00:00"),
      false
    );
    check("the swap is reported as applied", swapOutcome.applied, JSON.stringify(swapOutcome));
    check("both sessions changed places", swapOutcome.changes.length === 2);

    console.log("\nAn unresolvable reference fails clearly, not silently:");
    const badOutcome = await resolveScheduleAction(
      user.id,
      { kind: "move", sessionToken: "S99", toDate: "2026-08-20", otherToken: null },
      tokenToSession,
      new Date("2026-08-10T09:00:00"),
      false
    );
    check("attempted is still true, so the coach explains rather than stays silent", badOutcome.attempted);
    check("but nothing is applied", !badOutcome.applied);
    check("a reason is given", !!badOutcome.rejectedReason);

    console.log("\nA dry run previews without writing:");
    const before = (await prisma.plannedSession.findUnique({ where: { id: run.id } }))!.scheduledDate;
    const dryOutcome = await resolveScheduleAction(
      user.id,
      { kind: "move", sessionToken: "S1", toDate: "2026-08-21", otherToken: null },
      tokenToSession,
      new Date("2026-08-10T09:00:00"),
      true
    );
    const after = (await prisma.plannedSession.findUnique({ where: { id: run.id } }))!.scheduledDate;
    check("a dry run does not write to the database", before?.getTime() === after?.getTime());
    check("but still describes the change that would happen", dryOutcome.changes.length === 1, JSON.stringify(dryOutcome));
  } finally {
    const plans = await prisma.trainingPlan.findMany({ where: { userId: user.id }, select: { id: true } });
    await prisma.planVersion.deleteMany({ where: { planId: { in: plans.map((p) => p.id) } } });
    await prisma.adaptation.deleteMany({ where: { planId: { in: plans.map((p) => p.id) } } });
    await prisma.planWeekOutline.deleteMany({ where: { planId: { in: plans.map((p) => p.id) } } });
    await prisma.plannedSession.deleteMany({ where: { planId: { in: plans.map((p) => p.id) } } });
    await prisma.trainingPlan.deleteMany({ where: { userId: user.id } });
    await prisma.athleteProfile.deleteMany({ where: { userId: user.id } });
    await prisma.user.deleteMany({ where: { id: user.id } });
    check("test account removed", (await prisma.user.count({ where: { id: user.id } })) === 0);
  }

  console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
  await prisma.$disconnect();
  if (failed > 0) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
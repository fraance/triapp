/**
 * Tests for the judgement calls the engine puts to the athlete.
 *
 * The risk being guarded against is a question that does nothing: if an answer
 * has no effect, the athlete learns their input is decorative and stops
 * engaging. So these check the answer actually changes the plan's behaviour,
 * and that the same question is never asked twice.
 *
 * Run with:  npm run test:decisions
 */
import "./env.mts";
import {
  raiseDecision,
  getPendingDecisions,
  answerDecision,
  withdrawDecision,
  askAboutComeback,
  preferredRampRate,
  RAMP_AFTER_BREAK,
  RAMP_BY_ANSWER,
} from "../lib/adaptation/decisions";
import { createUser } from "../lib/db";
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

async function main() {
  console.log("\nTriApp — plan decision tests\n");

  const user = await createUser(`decide-${Date.now()}@test.local`, "pw-test-1234");

  try {
    console.log("A question is asked once, and remembered:");

    await raiseDecision(user.id, {
      kind: "test_kind",
      question: "Pick one?",
      context: "Because.",
      options: [
        { id: "a", label: "A", detail: "first", recommended: true },
        { id: "b", label: "B", detail: "second" },
      ],
    });

    let pending = await getPendingDecisions(user.id);
    check("it shows up as pending", pending.length === 1);
    check("with its options", pending[0].options.length === 2);
    check("and a recommendation", pending[0].options[0].recommended === true);

    // Raising it again must not duplicate it.
    await raiseDecision(user.id, {
      kind: "test_kind", question: "Pick one?", context: "Updated.",
      options: [{ id: "a", label: "A", detail: "first" }],
    });
    pending = await getPendingDecisions(user.id);
    check("raising it again does not duplicate it", pending.length === 1);
    check("but the evidence can be refreshed", pending[0].context === "Updated.");

    const bad = await answerDecision(user.id, "test_kind", "not-an-option");
    check("an invalid answer is refused", !bad.applied, bad.message);

    const ok = await answerDecision(user.id, "test_kind", "a");
    check("a valid answer is recorded", ok.applied);
    check("and the question disappears",
      (await getPendingDecisions(user.id)).length === 0);

    await raiseDecision(user.id, {
      kind: "test_kind", question: "Again?", context: "…",
      options: [{ id: "a", label: "A", detail: "x" }],
    });
    check("an answered question is never re-asked",
      (await getPendingDecisions(user.id)).length === 0,
      "re-asking is exactly the interrogation the North Star forbids");

    const twice = await answerDecision(user.id, "test_kind", "a");
    check("it cannot be answered twice", !twice.applied);

    console.log("\nThe comeback question, and what it changes:");

    await askAboutComeback(user.id, {
      recentWeeklyLoad: 330, peakWeeklyLoad: 863,
      weekOneLoad: 346, weekOneHours: 4.5, weeksToRace: 6,
    });
    const comeback = (await getPendingDecisions(user.id)).find(
      (d) => d.kind === RAMP_AFTER_BREAK
    );
    check("a big gap between current and best raises the question", !!comeback);
    check("the athlete is shown both numbers",
      (comeback?.context ?? "").includes("330") && (comeback?.context ?? "").includes("863"),
      comeback?.context);
    check("three routes are offered", comeback?.options.length === 3);
    check("the cautious one is recommended",
      comeback?.options.find((o) => o.recommended)?.id === "cautious");

    check("no preference is set before answering",
      (await preferredRampRate(user.id)) === null);

    const answer = await answerDecision(user.id, RAMP_AFTER_BREAK, "standard");
    check("answering it applies", answer.applied);
    check("and says the plan must be rebuilt for it to take effect",
      answer.requiresRebuild === true);
    check("the chosen ramp is stored and used",
      (await preferredRampRate(user.id)) === RAMP_BY_ANSWER.standard,
      String(await preferredRampRate(user.id)));

    console.log("\nA question that no longer applies is withdrawn, not answered:");

    await raiseDecision(user.id, {
      kind: "temporary", question: "Still relevant?", context: "…",
      options: [{ id: "y", label: "Yes", detail: "" }],
    });
    await withdrawDecision(user.id, "temporary");
    check("it stops being pending",
      !(await getPendingDecisions(user.id)).some((d) => d.kind === "temporary"));
    const row = await prisma.planDecision.findUnique({
      where: { userId_kind: { userId: user.id, kind: "temporary" } },
    });
    check("and is not recorded as though the athlete chose",
      row?.status === "expired" && row?.answer === null,
      `${row?.status} / ${row?.answer}`);

    // A close gap is not a question at all.
    const other = await createUser(`decide2-${Date.now()}@test.local`, "pw-test-1234");
    try {
      await askAboutComeback(other.id, {
        recentWeeklyLoad: 500, peakWeeklyLoad: 550,
        weekOneLoad: 520, weekOneHours: 7, weeksToRace: 8,
      });
      check("no question when the athlete is already near their best",
        (await getPendingDecisions(other.id)).length === 0,
        "asking would be cognitive load for nothing");
    } finally {
      await prisma.planDecision.deleteMany({ where: { userId: other.id } });
      await prisma.athleteProfile.deleteMany({ where: { userId: other.id } });
      await prisma.user.deleteMany({ where: { id: other.id } });
    }
  } finally {
    await prisma.planDecision.deleteMany({ where: { userId: user.id } });
    await prisma.athleteProfile.deleteMany({ where: { userId: user.id } });
    await prisma.user.deleteMany({ where: { id: user.id } });
    const left = await prisma.user.count({ where: { id: user.id } });
    console.log("\nCleanup:");
    check("test account removed", left === 0);
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

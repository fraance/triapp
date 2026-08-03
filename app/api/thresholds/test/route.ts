import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  computeManualThreshold,
  isManualError,
  manualProtocolFor,
} from "@/lib/adaptation/manual-test";
import { proposeThreshold, parseRecord } from "@/lib/adaptation/thresholds";
import type { ThresholdKind } from "@/lib/adaptation/physiology";

const KINDS = ["ftp", "css", "runThreshold", "maxHr", "thresholdHr"] as const;

function isKind(v: unknown): v is ThresholdKind {
  return typeof v === "string" && (KINDS as readonly string[]).includes(v);
}

/**
 * How to capture a threshold by hand — returned so the athlete can be shown the
 * protocol for a test their equipment cannot record.
 */
export async function GET(req: NextRequest) {
  const kind = req.nextUrl.searchParams.get("kind");
  if (!isKind(kind)) {
    return NextResponse.json({ error: "unknown threshold" }, { status: 400 });
  }
  const protocol = manualProtocolFor(kind);
  if (!protocol) {
    return NextResponse.json(
      { error: "this threshold cannot be captured by hand" },
      { status: 404 }
    );
  }
  return NextResponse.json({ protocol });
}

/**
 * Records a test the athlete captured themselves, or their decision to skip it.
 *
 * Body:
 *   { userId, kind, inputs: {...} }       submit a hand-captured result
 *   { userId, kind, action: "skip" }      decline, with a cooling-off period
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { userId, kind } = body ?? {};

    if (!userId || !isKind(kind)) {
      return NextResponse.json(
        { error: "userId and a valid kind are required" },
        { status: 400 }
      );
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return NextResponse.json({ error: "unknown user" }, { status: 404 });

    // ---- Skip -----------------------------------------------------------
    if (body.action === "skip") {
      const profile = await prisma.athleteProfile.findUnique({ where: { userId } });
      const prefs =
        profile?.testPreferences && typeof profile.testPreferences === "object"
          ? (profile.testPreferences as Record<string, unknown>)
          : {};

      await prisma.athleteProfile.upsert({
        where: { userId },
        create: {
          userId,
          testPreferences: { ...prefs, [kind]: { declinedAt: new Date().toISOString() } },
        } as never,
        update: {
          testPreferences: { ...prefs, [kind]: { declinedAt: new Date().toISOString() } },
        } as never,
      });

      // Put the session back to what it was, so skipping a test does not also
      // lose the athlete a training session.
      if (body.sessionId) {
        const session = await prisma.plannedSession.findUnique({
          where: { id: body.sessionId },
        });
        if (session?.isTest) {
          await prisma.plannedSession.update({
            where: { id: session.id },
            data: {
              isTest: false,
              testKind: null,
              testMode: null,
              type: "Endurance",
              tss: session.originalTss ?? session.tss,
            },
          });
        }
      }

      return NextResponse.json({
        skipped: true,
        message:
          "Skipped. We won't ask again for a few weeks, and the session goes " +
          "back to normal training.",
      });
    }

    // ---- Submit a hand-captured result ----------------------------------
    const result = computeManualThreshold(kind, body.inputs ?? {});
    if (isManualError(result)) {
      // A mistyped figure would silently drive every session after it, so a
      // rejected entry is a 400 with an explanation, never a stored guess.
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    const proposal = await proposeThreshold(userId, kind, result.value, "manual");

    if (body.sessionId) {
      await prisma.plannedSession.updateMany({
        where: { id: body.sessionId, isTest: true },
        data: { status: "completed", completedAt: new Date() },
      });
    }

    const record = parseRecord(
      (await prisma.athleteProfile.findUnique({ where: { userId } }))
        ?.thresholdsMeasuredAt
    );

    return NextResponse.json({
      kind,
      value: result.value,
      method: result.method,
      outcome: proposal.outcome,
      reason: proposal.reason,
      measuredAt: record[kind]?.at ?? null,
    });
  } catch (error: any) {
    console.error("Manual test submission failed:", error);
    return NextResponse.json(
      { error: error.message || "Could not record the test" },
      { status: 500 }
    );
  }
}

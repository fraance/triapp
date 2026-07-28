import { NextRequest, NextResponse } from "next/server";
import {
  getLatestPlanWithOutline,
  addDetailedWeeks,
  getProfile,
} from "@/lib/db";
import { generateDetailedWeeksBatched, type WeekOutline } from "@/lib/ai-coach";
import { buildTrainingHistory, formatHistoryForPrompt } from "@/lib/strava-db";
import { buildDocumentContext } from "@/lib/documents";
import { buildAthleteContext } from "@/lib/athlete-context";

export const maxDuration = 800;

/**
 * Generates detailed day-by-day sessions for weeks that currently only exist
 * as an outline — either a specific range, or the rest of the season.
 *
 * Body: { userId, fromWeek?, toWeek?, all? }
 */
export async function POST(req: NextRequest) {
  try {
    const { userId, fromWeek, toWeek, all } = await req.json();

    if (!userId) {
      return NextResponse.json({ error: "userId is required" }, { status: 400 });
    }

    const plan = await getLatestPlanWithOutline(userId);
    if (!plan) {
      return NextResponse.json(
        { error: "No training plan yet — generate one first." },
        { status: 404 }
      );
    }
    if (plan.outline.length === 0) {
      return NextResponse.json(
        { error: "This plan has no season outline. Please regenerate it." },
        { status: 400 }
      );
    }

    // Which weeks already have detail?
    const detailed = new Set(
      (
        await (await import("@/lib/prisma")).prisma.plannedSession.findMany({
          where: { planId: plan.id },
          select: { week: true },
          distinct: ["week"],
        })
      ).map((s) => s.week)
    );

    let targets: WeekOutline[] = plan.outline.map((o) => ({
      week: o.week,
      phase: o.phase,
      focus: o.focus ?? "",
      targetHours: o.targetHours ?? 0,
      targetTss: o.targetTss ?? 0,
      isRaceWeek: o.isRaceWeek,
    }));

    if (all) {
      // Everything that isn't detailed yet.
      targets = targets.filter((w) => !detailed.has(w.week));
    } else {
      const from = Number(fromWeek) || 1;
      const to = Number(toWeek) || from;
      targets = targets.filter((w) => w.week >= from && w.week <= to);
    }

    if (targets.length === 0) {
      return NextResponse.json({
        generatedWeeks: 0,
        message: "Those weeks already have detailed sessions.",
      });
    }

    // Rebuild the athlete context so new weeks are as informed as the first ones.
    const profile = await getProfile(userId);
    const contextParts: string[] = [];
    try {
      const athlete = await buildAthleteContext(userId);
      if (athlete) contextParts.push(athlete);
    } catch {}
    try {
      const history = await buildTrainingHistory(userId);
      if (history.hasData) contextParts.push(formatHistoryForPrompt(history));
    } catch {}
    try {
      const docs = await buildDocumentContext(userId);
      if (docs) contextParts.push(docs);
    } catch {}

    const weeks = await generateDetailedWeeksBatched(
      {
        age: profile?.age ?? undefined,
        gender: profile?.gender ?? undefined,
        raceType: profile?.raceType ?? undefined,
        raceDate: profile?.raceDate?.toISOString().split("T")[0],
        pastPerformance: profile?.pastPerformance ?? undefined,
      },
      targets,
      contextParts.join("\n\n")
    );

    const sessionsAdded = await addDetailedWeeks(plan.id, weeks);

    return NextResponse.json({
      generatedWeeks: weeks.length,
      sessionsAdded,
      weeks: weeks.map((w: any) => w.week),
    });
  } catch (error: any) {
    console.error("Plan expansion error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to generate sessions" },
      { status: 500 }
    );
  }
}

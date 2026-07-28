import { generateTrainingPlan } from "@/lib/ai-coach";
import { saveFullPlan } from "@/lib/db";
import { buildTrainingHistory, formatHistoryForPrompt } from "@/lib/strava-db";
import { buildDocumentContext } from "@/lib/documents";
import { buildAthleteContext } from "@/lib/athlete-context";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { userId, detailWeeks, ...profile } = body;

    // Ground the plan in the athlete's real data when we have it.
    const contextParts: string[] = [];
    let usedHistory = false;
    let usedDocuments = false;

    if (userId) {
      // Full athlete picture: physiology, equipment, race demands, tests needed.
      try {
        const athlete = await buildAthleteContext(userId);
        if (athlete) contextParts.push(athlete);
      } catch (e) {
        console.error("Could not build athlete context:", e);
      }

      try {
        const history = await buildTrainingHistory(userId);
        if (history.hasData) {
          contextParts.push(formatHistoryForPrompt(history));
          usedHistory = true;
        }
      } catch (e) {
        console.error("Could not build training history:", e);
      }

      try {
        const docs = await buildDocumentContext(userId);
        if (docs) {
          contextParts.push(docs);
          usedDocuments = true;
        }
      } catch (e) {
        console.error("Could not build document context:", e);
      }
    }

    const context = contextParts.join("\n\n");

    const { outline, weeks, totalWeeks, detailWeeks: detailed } =
      await generateTrainingPlan(profile, context, {
        detailWeeks: detailWeeks === "all" ? "all" : Number(detailWeeks) || 4,
      });

    if (userId) {
      const targetRaceDate = profile.raceDate
        ? new Date(profile.raceDate)
        : new Date(Date.now() + 16 * 7 * 24 * 60 * 60 * 1000);
      await saveFullPlan(userId, targetRaceDate, weeks, new Date(), outline);
    }

    return NextResponse.json(
      {
        outline,
        weeks,
        totalWeeks,
        detailWeeks: detailed,
        usedStravaHistory: usedHistory,
        usedDocuments,
      },
      { status: 200 }
    );
  } catch (error: any) {
    console.error("Plan generation error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to generate plan" },
      { status: 500 }
    );
  }
}

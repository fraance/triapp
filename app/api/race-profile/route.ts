import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { researchRace } from "@/lib/race-profile";

export const maxDuration = 120;

/** Read the athlete's race profile. */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const userId = searchParams.get("userId");
    if (!userId) {
      return NextResponse.json({ error: "userId is required" }, { status: 400 });
    }
    const race = await prisma.raceProfile.findUnique({ where: { userId } });
    return NextResponse.json(race ?? {});
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || "Failed to load race profile" },
      { status: 500 }
    );
  }
}

/**
 * Ask the AI what it knows about the race. Results are stored as SUGGESTIONS
 * that the athlete must confirm — never used as fact until then.
 */
export async function PUT(req: NextRequest) {
  try {
    const { userId, raceName, location, raceDate, distanceType } =
      await req.json();
    if (!userId) {
      return NextResponse.json({ error: "userId is required" }, { status: 400 });
    }

    const research = await researchRace({ raceName, location, raceDate, distanceType });

    const data = {
      raceName: research.raceName ?? raceName ?? null,
      location: research.location ?? location ?? null,
      raceDate: raceDate ? new Date(raceDate) : null,
      distanceType: distanceType ?? null,
      swimEnvironment: research.swimEnvironment,
      waterTempC: research.waterTempC,
      wetsuitLikely: research.wetsuitLikely,
      swimNotes: research.swimNotes,
      bikeElevationGainM: research.bikeElevationGainM,
      bikeCourseType: research.bikeCourseType,
      bikeNotes: research.bikeNotes,
      runElevationGainM: research.runElevationGainM,
      runCourseType: research.runCourseType,
      runSurface: research.runSurface,
      runNotes: research.runNotes,
      expectedTempC: research.expectedTempC,
      expectedHumidity: research.expectedHumidity,
      windNotes: research.windNotes,
      source: research.usedWebSearch ? "web_research" : "ai_suggested",
      confirmed: false,
      aiConfidence: research.aiConfidence,
      sources: research.sources.length ? research.sources.join("\n") : null,
      researchedAt: new Date(),
    };

    const race = await prisma.raceProfile.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });

    return NextResponse.json({
      race,
      aiConfidence: research.aiConfidence,
      unknownFields: research.unknownFields,
      questionsForAthlete: research.questionsForAthlete,
      sources: research.sources,
      usedWebSearch: research.usedWebSearch,
      raceIdentified: research.raceIdentified,
    });
  } catch (error: any) {
    console.error("Race research error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to research race" },
      { status: 500 }
    );
  }
}

const num = (v: any) => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function pick<T>(body: any, key: string, transform: (v: any) => T): T | undefined {
  if (!(key in body)) return undefined;
  return transform(body[key]);
}

/** Save the athlete's own answers (and mark the profile confirmed). */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { userId } = body;
    if (!userId) {
      return NextResponse.json({ error: "userId is required" }, { status: 400 });
    }

    const raw = {
      raceName: pick(body, "raceName", (v) => v || null),
      location: pick(body, "location", (v) => v || null),
      raceDate: pick(body, "raceDate", (v) => (v ? new Date(v) : null)),
      distanceType: pick(body, "distanceType", (v) => v || null),
      swimEnvironment: pick(body, "swimEnvironment", (v) => v || null),
      waterTempC: pick(body, "waterTempC", num),
      wetsuitLikely: pick(body, "wetsuitLikely", (v) =>
        v === null || v === "" || v === undefined ? null : Boolean(v)
      ),
      swimNotes: pick(body, "swimNotes", (v) => v || null),
      bikeElevationGainM: pick(body, "bikeElevationGainM", (v) => {
        const n = num(v);
        return n === null ? null : Math.round(n);
      }),
      bikeCourseType: pick(body, "bikeCourseType", (v) => v || null),
      bikeNotes: pick(body, "bikeNotes", (v) => v || null),
      runElevationGainM: pick(body, "runElevationGainM", (v) => {
        const n = num(v);
        return n === null ? null : Math.round(n);
      }),
      runCourseType: pick(body, "runCourseType", (v) => v || null),
      runSurface: pick(body, "runSurface", (v) => v || null),
      runNotes: pick(body, "runNotes", (v) => v || null),
      expectedTempC: pick(body, "expectedTempC", num),
      expectedHumidity: pick(body, "expectedHumidity", (v) => {
        const n = num(v);
        return n === null ? null : Math.round(n);
      }),
      windNotes: pick(body, "windNotes", (v) => v || null),
      confirmed: pick(body, "confirmed", (v) => Boolean(v)) ?? true,
      source: "manual",
    };

    // Only write keys the client actually sent.
    const data: Record<string, any> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v !== undefined) data[k] = v;
    }

    const race = await prisma.raceProfile.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });

    return NextResponse.json(race);
  } catch (error: any) {
    console.error("Race profile save error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to save race profile" },
      { status: 500 }
    );
  }
}

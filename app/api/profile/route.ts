import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);

    if (!session || !(session.user as any)?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const profile = await prisma.athleteProfile.findUnique({
      where: { userId: (session.user as any).id },
    });

    return NextResponse.json(profile || {}, { status: 200 });
  } catch (error) {
    console.error("Profile fetch error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);

    if (!session || !(session.user as any)?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { age, gender, raceDate, raceType, pastPerformance, timezone } = body;

    const profile = await prisma.athleteProfile.upsert({
      where: { userId: (session.user as any).id },
      update: {
        age,
        gender,
        raceDate: raceDate ? new Date(raceDate) : null,
        raceType,
        pastPerformance,
        timezone,
      },
      create: {
        userId: (session.user as any).id,
        age,
        gender,
        raceDate: raceDate ? new Date(raceDate) : null,
        raceType,
        pastPerformance,
        timezone,
      },
    });

    return NextResponse.json(profile, { status: 200 });
  } catch (error) {
    console.error("Profile save error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

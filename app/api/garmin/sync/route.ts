import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const { sessions } = await req.json();

    if (!sessions || !Array.isArray(sessions)) {
      return NextResponse.json(
        { error: "sessions array is required" },
        { status: 400 }
      );
    }

    // Get Garmin token from cookie (mock for now)
    const garminToken = req.cookies.get("garmin_token")?.value;

    if (!garminToken) {
      return NextResponse.json(
        { error: "Garmin not connected. Please connect first." },
        { status: 401 }
      );
    }

    // Mock: Return success with workout IDs
    // In production, use Garmin API to create workouts
    const createdWorkouts = sessions.map((session: any, index: number) => ({
      workoutId: `mock-workout-${Date.now()}-${index}`,
      discipline: session.discipline,
      type: session.type,
      duration: session.duration,
      tss: session.tss,
      status: "created",
    }));

    return NextResponse.json(
      {
        success: true,
        message: `${createdWorkouts.length} sessions synced to Garmin (mock)`,
        workouts: createdWorkouts,
      },
      { status: 200 }
    );
  } catch (error: any) {
    console.error("Error syncing to Garmin:", error);
    return NextResponse.json(
      { error: error.message || "Failed to sync to Garmin" },
      { status: 500 }
    );
  }
}

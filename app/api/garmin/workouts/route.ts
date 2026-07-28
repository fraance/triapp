import { NextRequest, NextResponse } from "next/server";
import { getMockWorkouts } from "@/lib/garmin-config";

export async function GET(req: NextRequest) {
  try {
    const garminToken = req.cookies.get("garmin_token")?.value;

    if (!garminToken) {
      return NextResponse.json(
        { error: "Not connected to Garmin" },
        { status: 401 }
      );
    }

    // For MVP: Return mock workouts
    // In production: Call Garmin API with token to fetch real workouts
    const mockWorkouts = getMockWorkouts(30);

    return NextResponse.json({
      workouts: mockWorkouts,
      connected: true,
      lastSync: new Date(),
    });
  } catch (error: any) {
    console.error("Error fetching workouts:", error);
    return NextResponse.json(
      { error: error.message || "Failed to fetch workouts" },
      { status: 500 }
    );
  }
}

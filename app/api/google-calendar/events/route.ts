import { NextRequest, NextResponse } from "next/server";
import { getMockCalendarEvents } from "@/lib/google-calendar-config";

export async function GET(req: NextRequest) {
  try {
    const googleToken = req.cookies.get("google_calendar_token")?.value;

    if (!googleToken) {
      return NextResponse.json(
        { error: "Not connected to Google Calendar" },
        { status: 401 }
      );
    }

    // For MVP: Return mock calendar events
    // In production: Call Google Calendar API with token to fetch real events
    const mockEvents = getMockCalendarEvents();

    return NextResponse.json({
      events: mockEvents,
      connected: true,
      lastSync: new Date(),
    });
  } catch (error: any) {
    console.error("Error fetching calendar events:", error);
    return NextResponse.json(
      { error: error.message || "Failed to fetch calendar events" },
      { status: 500 }
    );
  }
}

import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const { sessions, calendarId } = await req.json();

    if (!sessions || !Array.isArray(sessions)) {
      return NextResponse.json(
        { error: "sessions array is required" },
        { status: 400 }
      );
    }

    // Get Google Calendar token from cookie (mock for now)
    const googleToken = req.cookies.get("google_calendar_token")?.value;

    if (!googleToken) {
      return NextResponse.json(
        { error: "Google Calendar not connected. Please connect first." },
        { status: 401 }
      );
    }

    // Mock: Return success with event IDs
    // In production, use google-auth-library to call Google Calendar API
    const createdEvents = sessions.map((session: any, index: number) => ({
      eventId: `mock-event-${Date.now()}-${index}`,
      summary: `${session.discipline} - ${session.type}`,
      startTime: new Date(),
      endTime: new Date(),
      status: "created",
    }));

    return NextResponse.json(
      {
        success: true,
        message: `${createdEvents.length} sessions synced to Google Calendar (mock)`,
        events: createdEvents,
      },
      { status: 200 }
    );
  } catch (error: any) {
    console.error("Error syncing to Google Calendar:", error);
    return NextResponse.json(
      { error: error.message || "Failed to sync to Google Calendar" },
      { status: 500 }
    );
  }
}

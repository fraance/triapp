import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const planId = searchParams.get("planId");

    if (!planId) {
      return NextResponse.json(
        { error: "planId is required" },
        { status: 400 }
      );
    }

    // Get plan from localStorage (for now, until we migrate to DB)
    // In production, fetch from database
    const plan = JSON.parse(
      req.cookies.get(`triapp_plan_${planId}`)?.value || "[]"
    );

    if (!plan || plan.length === 0) {
      return NextResponse.json(
        { error: "Plan not found" },
        { status: 404 }
      );
    }

    // Generate ICS (iCalendar) format
    const icsLines: string[] = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//TriApp//Training Plan//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
    ];

    // Add events for each session
    plan.forEach((week: any) => {
      week.sessions?.forEach((session: any) => {
        // Calculate actual date (need plan start date, using today as reference)
        const today = new Date();
        const sessionDate = new Date(
          today.getTime() + (week.week - 1) * 7 * 24 * 60 * 60 * 1000
        );

        // Map day name to day offset
        const dayMap: { [key: string]: number } = {
          Monday: 0,
          Tuesday: 1,
          Wednesday: 2,
          Thursday: 3,
          Friday: 4,
          Saturday: 5,
          Sunday: 6,
        };
        const dayOffset = dayMap[session.day] || 0;
        sessionDate.setDate(
          sessionDate.getDate() - sessionDate.getDay() + dayOffset
        );

        // Start time: 6:00 AM
        const startTime = new Date(sessionDate);
        startTime.setHours(6, 0, 0, 0);

        // Parse duration (e.g., "45 min" -> minutes)
        const durationMatch = session.duration.match(/(\d+)/);
        const durationMinutes = durationMatch
          ? parseInt(durationMatch[1])
          : 30;

        const endTime = new Date(startTime.getTime() + durationMinutes * 60 * 1000);

        // Format dates for ICS (YYYYMMDDTHHMMSSZ)
        const formatIcsDate = (date: Date) => {
          return date.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
        };

        const uid = `triapp-${week.week}-${session.day}-${session.discipline}@triapp.local`;
        const summary = `${session.discipline} - ${session.type} (TSS: ${session.tss})`;
        const description = session.instructions || session.pace || "";

        icsLines.push("BEGIN:VEVENT");
        icsLines.push(`UID:${uid}`);
        icsLines.push(`DTSTART:${formatIcsDate(startTime)}`);
        icsLines.push(`DTEND:${formatIcsDate(endTime)}`);
        icsLines.push(`SUMMARY:${summary}`);
        if (description) {
          icsLines.push(`DESCRIPTION:${description.replace(/\n/g, "\\n")}`);
        }
        icsLines.push(`CREATED:${formatIcsDate(new Date())}`);
        icsLines.push("STATUS:CONFIRMED");
        icsLines.push("END:VEVENT");
      });
    });

    icsLines.push("END:VCALENDAR");

    const icsContent = icsLines.join("\r\n");

    return new NextResponse(icsContent, {
      status: 200,
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": 'attachment; filename="triapp-training-plan.ics"',
      },
    });
  } catch (error: any) {
    console.error("Error generating ICS:", error);
    return NextResponse.json(
      { error: error.message || "Failed to generate ICS" },
      { status: 500 }
    );
  }
}

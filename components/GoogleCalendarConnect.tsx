"use client";

/**
 * Google Calendar is NOT connected — the integration has not been built yet.
 * We show the real status rather than a button that fakes a connection.
 */
export function GoogleCalendarConnect() {
  return (
    <div className="well">
      <p className="eyebrow mb-2.5">
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-gray-300" />
        Not connected
      </p>
      <p className="text-gray-700 text-[15px] leading-relaxed">
        Calendar sync hasn&apos;t been built yet. No calendar data is being read,
        and your sessions are not being written to any calendar.
      </p>
    </div>
  );
}

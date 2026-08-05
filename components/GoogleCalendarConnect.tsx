"use client";

/**
 * Google Calendar is NOT connected — the integration has not been built yet.
 * We show the real status rather than a button that fakes a connection.
 */
export function GoogleCalendarConnect() {
  return (
    <div className="card card-pad bg-gray-50">
      <p className="font-semibold text-gray-800">Not connected</p>
      <p className="text-gray-600 text-sm mt-1">
        Calendar sync hasn&apos;t been built yet. No calendar data is being read,
        and your sessions are not being written to any calendar.
      </p>
    </div>
  );
}

"use client";

import Link from "next/link";

/**
 * Calendar sync has not been built. This page previously listed invented
 * events; it now states the real position.
 */
export default function CalendarPage() {
  return (
    <div className="page-shell">
      <div className="page-inner-narrow">
        <header className="mb-8 sm:mb-10">
          <p className="eyebrow mb-3">Settings · Integration</p>
          <h1 className="page-title">Calendar</h1>
        </header>

        <div className="card card-pad">
          <p className="font-semibold text-gray-800 mb-2">Not connected</p>
          <p className="text-gray-700">
            Calendar sync hasn&apos;t been built yet. Nothing is being read from
            your calendar, and your sessions are not being written to it.
          </p>
          <p className="text-gray-700 mt-4">
            You can still export your plan as a calendar file and import it
            manually.
          </p>
          <Link
            href="/season"
            className="inline-block mt-4 btn btn-primary"
          >
            View my plan
          </Link>
        </div>
      </div>
    </div>
  );
}

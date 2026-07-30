"use client";

import Link from "next/link";

/**
 * Calendar sync has not been built. This page previously listed invented
 * events; it now states the real position.
 */
export default function CalendarPage() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 py-10 px-4">
      <div className="max-w-3xl mx-auto">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-3xl font-bold text-indigo-900">Calendar</h1>
          <Link
            href="/today"
            className="bg-indigo-600 text-white px-4 py-2 rounded-lg"
          >
            Today
          </Link>
        </div>

        <div className="bg-white rounded-lg shadow p-6">
          <p className="font-semibold text-gray-800 mb-2">Not connected</p>
          <p className="text-gray-700">
            Calendar sync hasn&apos;t been built yet. Nothing is being read from
            your calendar, and your sessions are not being written to it.
          </p>
        </div>
      </div>
    </div>
  );
}

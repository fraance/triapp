"use client";

import Link from "next/link";

/**
 * Garmin workouts are not available yet. This page used to display fabricated
 * workouts; it now states the real position so nothing can be mistaken for
 * genuine training data.
 */
export default function WorkoutsPage() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 py-10 px-4">
      <div className="max-w-3xl mx-auto">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-3xl font-bold text-indigo-900">Garmin workouts</h1>
          <Link
            href="/today"
            className="bg-indigo-600 text-white px-4 py-2 rounded-lg"
          >
            Today
          </Link>
        </div>

        <div className="bg-white rounded-lg shadow p-6">
          <p className="font-semibold text-gray-800 mb-2">Not connected</p>
          <p className="text-gray-700 mb-4">
            Garmin access is pending approval of our developer application. No
            Garmin data is being imported, and none is used in your plan.
          </p>
          <p className="text-gray-700">
            Your completed training currently comes from Strava.
          </p>
          <Link
            href="/strava"
            className="inline-block mt-4 bg-orange-600 text-white px-5 py-2 rounded-lg"
          >
            View Strava data
          </Link>
        </div>
      </div>
    </div>
  );
}

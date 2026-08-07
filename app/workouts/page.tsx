"use client";

import Link from "next/link";

/**
 * Garmin workouts are not available yet. This page used to display fabricated
 * workouts; it now states the real position so nothing can be mistaken for
 * genuine training data.
 */
export default function WorkoutsPage() {
  return (
    <div className="page-shell">
      <div className="page-inner-narrow">
        <header className="mb-8 sm:mb-10">
          <p className="eyebrow mb-3">Settings / Integration</p>
          <h1 className="page-title">Garmin workouts</h1>
        </header>

        <div className="card card-pad">
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
            className="inline-block mt-4 btn btn-primary"
          >
            View Strava data
          </Link>
        </div>
      </div>
    </div>
  );
}

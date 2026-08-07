"use client";

/**
 * Garmin is NOT connected and cannot be yet.
 *
 * Our Garmin Connect Developer Program application is still under review, so
 * there is no way to link an account. We show the real status rather than a
 * button that pretends to work.
 */
export function GarminConnect() {
  return (
    <div className="well">
      <p className="eyebrow mb-2.5">
        <span aria-hidden="true" className="h-1.5 w-1.5 bg-gray-400" />
        Not connected
      </p>
      <p className="text-sm text-gray-700 leading-relaxed">
        Garmin access is pending approval of our developer application. Until
        Garmin grants access there is no way to link your account, so no Garmin
        data is being used anywhere in your plan.
      </p>
      <p className="hint">In the meantime your training data comes from Strava.</p>
    </div>
  );
}

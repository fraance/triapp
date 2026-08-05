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
    <div className="card card-pad bg-gray-50">
      <p className="font-semibold text-gray-800">Not connected</p>
      <p className="text-gray-600 text-sm mt-1">
        Garmin access is pending approval of our developer application. Until
        Garmin grants access there is no way to link your account, so no Garmin
        data is being used anywhere in your plan.
      </p>
      <p className="text-gray-500 text-sm mt-2">
        In the meantime your training data comes from Strava.
      </p>
    </div>
  );
}

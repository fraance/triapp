"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

export function GarminConnect() {
  const [isConnected, setIsConnected] = useState(false);
  const [isChecking, setIsChecking] = useState(true);

  useEffect(() => {
    // Check if Garmin is connected by looking for the token
    const token = document.cookie
      .split("; ")
      .find((row) => row.startsWith("garmin_token"));
    setIsConnected(!!token);
    setIsChecking(false);
  }, []);

  const handleConnect = () => {
    // For MVP with mock data, just set the cookie and redirect
    // In production, this would redirect to Garmin OAuth
    document.cookie =
      "garmin_token=mock_garmin_token_12345; max-age=31536000; path=/";
    setIsConnected(true);
    window.location.href = "/workouts";
  };

  if (isChecking) {
    return <div className="text-gray-600">Checking Garmin connection...</div>;
  }

  return (
    <div className="flex gap-4 items-center">
      {isConnected ? (
        <>
          <span className="text-green-600 font-semibold">✓ Garmin Connected</span>
          <Link
            href="/workouts"
            className="bg-green-600 text-white px-6 py-2 rounded-lg hover:bg-green-700 transition"
          >
            View Workouts
          </Link>
        </>
      ) : (
        <button
          onClick={handleConnect}
          className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 transition"
        >
          Connect Garmin
        </button>
      )}
    </div>
  );
}

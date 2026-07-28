"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { GOOGLE_CALENDAR_CONFIG } from "@/lib/google-calendar-config";

export function GoogleCalendarConnect() {
  const [isConnected, setIsConnected] = useState(false);
  const [isChecking, setIsChecking] = useState(true);

  useEffect(() => {
    // Check if Google Calendar is connected by looking for the token
    const token = document.cookie
      .split("; ")
      .find((row) => row.startsWith("google_calendar_token"));
    setIsConnected(!!token);
    setIsChecking(false);
  }, []);

  const handleConnect = () => {
    // For MVP with mock data, just set the cookie and redirect
    // In production, this would redirect to Google OAuth
    document.cookie =
      "google_calendar_token=mock_google_token_12345; max-age=31536000; path=/";
    setIsConnected(true);
    window.location.href = "/calendar";
  };

  if (isChecking) {
    return <div className="text-gray-600">Checking Google Calendar connection...</div>;
  }

  return (
    <div className="flex gap-4 items-center">
      {isConnected ? (
        <>
          <span className="text-green-600 font-semibold">✓ Google Calendar Connected</span>
          <Link
            href="/calendar"
            className="bg-green-600 text-white px-6 py-2 rounded-lg hover:bg-green-700 transition"
          >
            View Calendar Events
          </Link>
        </>
      ) : (
        <button
          onClick={handleConnect}
          className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 transition"
        >
          Connect Google Calendar
        </button>
      )}
    </div>
  );
}

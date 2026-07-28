"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface CalendarEvent {
  id: string;
  summary: string;
  start: Date;
  end: Date;
  description?: string;
  location?: string;
  allDay: boolean;
}

export default function CalendarPage() {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    loadEvents();
  }, []);

  async function loadEvents() {
    try {
      setIsLoading(true);
      const res = await fetch("/api/google-calendar/events");

      if (!res.ok) {
        if (res.status === 401) {
          setConnected(false);
          setError("Not connected to Google Calendar. Please connect first.");
          return;
        }
        throw new Error("Failed to load calendar events");
      }

      const data = await res.json();
      const formattedEvents = (data.events || []).map((e: any) => ({
        ...e,
        start: new Date(e.start),
        end: new Date(e.end),
      }));
      setEvents(formattedEvents);
      setConnected(true);
    } catch (err: any) {
      setError(err.message || "Failed to load calendar events");
      setConnected(false);
    } finally {
      setIsLoading(false);
    }
  }

  function formatDate(date: Date) {
    return date.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  function formatTime(date: Date) {
    return date.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
  }

  function getDaysUntil(date: Date) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const target = new Date(date);
    target.setHours(0, 0, 0, 0);
    const diff = target.getTime() - today.getTime();
    const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
    return days;
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 py-12 px-4">
      <div className="max-w-6xl mx-auto">
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-3xl font-bold text-indigo-900">My Calendar Events</h1>
          <Link
            href="/profile"
            className="bg-indigo-600 text-white px-4 py-2 rounded-lg hover:bg-indigo-700 transition"
          >
            Back to Profile
          </Link>
        </div>

        {error && (
          <div className="bg-red-100 text-red-700 px-6 py-4 rounded-lg mb-8">
            {error}
          </div>
        )}

        {isLoading ? (
          <div className="bg-white rounded-lg shadow-lg p-8 text-center">
            <p className="text-gray-600">Loading calendar events...</p>
          </div>
        ) : events.length === 0 ? (
          <div className="bg-white rounded-lg shadow-lg p-8 text-center">
            <p className="text-gray-600 mb-4">No upcoming events.</p>
            <button
              onClick={loadEvents}
              className="bg-indigo-600 text-white px-6 py-2 rounded-lg hover:bg-indigo-700 transition"
            >
              Refresh
            </button>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="bg-white rounded-lg shadow-lg p-6">
              <h2 className="text-xl font-bold text-indigo-900 mb-2">
                Total Events: {events.length}
              </h2>
              <p className="text-gray-600">
                Upcoming events that may impact your training plan
              </p>
            </div>

            {events.map((event) => {
              const daysUntil = getDaysUntil(event.start);
              const isImmediate = daysUntil <= 7;

              return (
                <div
                  key={event.id}
                  className={`rounded-lg shadow-lg p-6 hover:shadow-xl transition ${
                    isImmediate
                      ? "bg-yellow-50 border-2 border-yellow-300"
                      : "bg-white"
                  }`}
                >
                  <div className="flex justify-between items-start mb-4">
                    <div>
                      <h3 className="text-2xl font-bold text-indigo-900">
                        {event.summary}
                      </h3>
                      <div className="text-sm text-gray-500 mt-1">
                        {event.allDay ? (
                          <p>All day • {formatDate(event.start)}</p>
                        ) : (
                          <>
                            <p>
                              {formatDate(event.start)} at {formatTime(event.start)}
                            </p>
                            {event.start.toDateString() !==
                              event.end.toDateString() && (
                              <p>
                                to {formatDate(event.end)} at{" "}
                                {formatTime(event.end)}
                              </p>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                    <div className="text-right">
                      {isImmediate && (
                        <span className="inline-block px-3 py-1 bg-yellow-300 text-yellow-900 rounded-full font-semibold text-sm mb-2">
                          ⚠️ Next {daysUntil} days
                        </span>
                      )}
                      {daysUntil > 0 && (
                        <p className="text-lg font-bold text-indigo-900">
                          {daysUntil === 1
                            ? "Tomorrow"
                            : `In ${daysUntil} days`}
                        </p>
                      )}
                    </div>
                  </div>

                  {event.location && (
                    <p className="text-gray-600 mb-3">
                      <strong>Location:</strong> {event.location}
                    </p>
                  )}

                  {event.description && (
                    <p className="text-gray-700 mb-3">{event.description}</p>
                  )}

                  {isImmediate && (
                    <div className="mt-4 p-3 bg-yellow-100 rounded border border-yellow-200">
                      <p className="text-sm text-yellow-900">
                        💡 This event is coming up soon. Your training plan may
                        need adjustment. Consider logging this as a life event
                        for AI coach to adapt your sessions.
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

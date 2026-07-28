"use client";

import { useEffect, useState, useCallback } from "react";
import { useAuth } from "@/lib/auth-context";
import { useRouter } from "next/navigation";
import Link from "next/link";

interface DaySession {
  id: string;
  discipline: string;
  type: string;
  duration: string;
  tss: number;
  instructions: string;
  pace: string;
  status: string;
  day: string;
  week: number;
  date: string;
}

interface TodayView {
  date: string;
  hasPlan: boolean;
  inPlanRange: boolean;
  week: number | null;
  phase: string | null;
  summary: string | null;
  sessions: DaySession[];
  tomorrow: DaySession[];
  weekTssPlanned: number;
  weekTssCompleted: number;
  daysUntilRace: number | null;
  raceDate: string | null;
}

export default function TodayPage() {
  const { user, isLoading: authLoading } = useAuth();
  const router = useRouter();
  const [view, setView] = useState<TodayView | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!user) return;
    try {
      setIsLoading(true);
      const res = await fetch(`/api/sessions/today?userId=${user.id}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load");
      setView(data);
      setError("");
    } catch (err: any) {
      setError(err.message || "Failed to load today's session");
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      router.push("/login");
      return;
    }
    load();
  }, [user, authLoading, router, load]);

  async function setStatus(sessionId: string, status: string) {
    if (!user) return;
    setBusyId(sessionId);
    try {
      const res = await fetch("/api/sessions/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, sessionId, status }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to update");
      await load();
    } catch (err: any) {
      setError(err.message || "Failed to update session");
    } finally {
      setBusyId(null);
    }
  }

  function prettyDate(iso: string) {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
    });
  }

  if (authLoading || isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-gray-600">Loading today&apos;s session...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 py-10 px-4">
      <div className="max-w-3xl mx-auto">
        <div className="flex justify-between items-center mb-6">
          <div>
            <h1 className="text-3xl font-bold text-indigo-900">Today</h1>
            {view && <p className="text-gray-600">{prettyDate(view.date)}</p>}
          </div>
          <div className="flex gap-2">
            <Link
              href="/dashboard"
              className="bg-white text-indigo-700 border border-indigo-300 px-4 py-2 rounded-lg"
            >
              Full plan
            </Link>
            <Link
              href="/profile"
              className="bg-indigo-600 text-white px-4 py-2 rounded-lg"
            >
              Profile
            </Link>
          </div>
        </div>

        {error && (
          <div className="bg-red-100 text-red-700 px-4 py-3 rounded mb-6">
            {error}
          </div>
        )}

        {/* No plan yet */}
        {view && !view.hasPlan && (
          <div className="bg-white rounded-lg shadow p-8 text-center">
            <p className="text-gray-700 mb-4">
              You don&apos;t have a training plan yet.
            </p>
            <Link
              href="/profile"
              className="inline-block bg-indigo-600 text-white px-6 py-3 rounded-lg font-semibold"
            >
              Generate my plan
            </Link>
          </div>
        )}

        {/* Week context */}
        {view && view.hasPlan && view.inPlanRange && (
          <div className="bg-white rounded-lg shadow p-6 mb-6">
            <div className="flex flex-wrap gap-6 justify-between">
              <div>
                <p className="text-sm text-gray-500">Week</p>
                <p className="text-xl font-bold text-indigo-900">
                  {view.week} {view.phase ? `· ${view.phase}` : ""}
                </p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Week load (TSS)</p>
                <p className="text-xl font-bold text-indigo-900">
                  {view.weekTssCompleted} / {view.weekTssPlanned}
                </p>
              </div>
              {view.daysUntilRace !== null && view.daysUntilRace >= 0 && (
                <div>
                  <p className="text-sm text-gray-500">Race in</p>
                  <p className="text-xl font-bold text-indigo-900">
                    {view.daysUntilRace} days
                  </p>
                </div>
              )}
            </div>
            {view.summary && (
              <p className="text-gray-600 mt-4">{view.summary}</p>
            )}
          </div>
        )}

        {/* Outside plan range */}
        {view && view.hasPlan && !view.inPlanRange && (
          <div className="bg-white rounded-lg shadow p-6 mb-6">
            <p className="text-gray-700">
              Today falls outside your current plan&apos;s date range. You can
              review the full plan or generate a new one.
            </p>
          </div>
        )}

        {/* Today's sessions */}
        {view && view.hasPlan && (
          <div className="mb-8">
            <h2 className="text-xl font-bold text-indigo-900 mb-3">
              Today&apos;s session
            </h2>

            {view.sessions.length === 0 ? (
              <div className="bg-white rounded-lg shadow p-6">
                <p className="text-gray-700 font-semibold">Rest day</p>
                <p className="text-gray-600">
                  Nothing scheduled for today. Recover well.
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {view.sessions.map((s) => (
                  <div key={s.id} className="bg-white rounded-lg shadow p-6">
                    <div className="flex justify-between items-start mb-3">
                      <div>
                        <h3 className="text-2xl font-bold text-indigo-900">
                          {s.discipline}
                        </h3>
                        <p className="text-indigo-600 font-semibold">{s.type}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-gray-700">{s.duration}</p>
                        <p className="text-gray-500 text-sm">TSS {s.tss}</p>
                        <p
                          className={`text-sm font-semibold mt-1 ${
                            s.status === "completed"
                              ? "text-green-600"
                              : s.status === "skipped"
                                ? "text-gray-500"
                                : "text-indigo-600"
                          }`}
                        >
                          {s.status}
                        </p>
                      </div>
                    </div>

                    {s.instructions && (
                      <div className="bg-gray-50 rounded p-4 mb-3">
                        <p className="text-gray-800">{s.instructions}</p>
                      </div>
                    )}
                    {s.pace && (
                      <p className="text-gray-600 mb-4">
                        <strong>Pace/Effort:</strong> {s.pace}
                      </p>
                    )}

                    <div className="flex gap-3">
                      <button
                        onClick={() => setStatus(s.id, "completed")}
                        disabled={busyId === s.id || s.status === "completed"}
                        className="bg-green-600 text-white px-5 py-2 rounded-lg disabled:opacity-50"
                      >
                        {busyId === s.id ? "Saving..." : "Mark completed"}
                      </button>
                      <button
                        onClick={() => setStatus(s.id, "skipped")}
                        disabled={busyId === s.id || s.status === "skipped"}
                        className="bg-gray-200 text-gray-800 px-5 py-2 rounded-lg disabled:opacity-50"
                      >
                        Skip
                      </button>
                      {s.status !== "planned" && (
                        <button
                          onClick={() => setStatus(s.id, "planned")}
                          disabled={busyId === s.id}
                          className="text-indigo-600 px-3 py-2 rounded-lg disabled:opacity-50"
                        >
                          Undo
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Tomorrow preview */}
        {view && view.hasPlan && (
          <div>
            <h2 className="text-xl font-bold text-indigo-900 mb-3">Tomorrow</h2>
            {view.tomorrow.length === 0 ? (
              <div className="bg-white rounded-lg shadow p-4">
                <p className="text-gray-600">Rest day</p>
              </div>
            ) : (
              <div className="space-y-3">
                {view.tomorrow.map((s) => (
                  <div
                    key={s.id}
                    className="bg-white rounded-lg shadow p-4 flex justify-between"
                  >
                    <div>
                      <p className="font-semibold text-gray-800">
                        {s.discipline} · {s.type}
                      </p>
                      <p className="text-gray-500 text-sm">{s.duration}</p>
                    </div>
                    <p className="text-gray-500 text-sm">TSS {s.tss}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

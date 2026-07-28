"use client";

import { useEffect, useState, useCallback } from "react";
import { useAuth } from "@/lib/auth-context";
import { useRouter } from "next/navigation";
import Link from "next/link";

interface Session {
  day: string;
  discipline: string;
  type: string;
  duration: string;
  tss: number;
  instructions: string;
  pace: string;
}

interface SeasonWeek {
  week: number;
  phase: string;
  focus: string | null;
  targetHours: number | null;
  targetTss: number | null;
  isRaceWeek: boolean;
  hasDetail: boolean;
  startDate: string | null;
  isCurrentWeek: boolean;
  sessions: Session[];
}

interface Season {
  hasPlan: boolean;
  totalWeeks: number;
  detailedWeeks: number;
  raceDate: string | null;
  currentWeek: number | null;
  weeks: SeasonWeek[];
}

const phaseColor: Record<string, string> = {
  Base: "bg-blue-100 text-blue-800",
  Build: "bg-orange-100 text-orange-800",
  Peak: "bg-red-100 text-red-800",
  Taper: "bg-purple-100 text-purple-800",
  Race: "bg-green-100 text-green-800",
  Recovery: "bg-gray-100 text-gray-700",
};

export default function SeasonPage() {
  const { user, isLoading: authLoading } = useAuth();
  const router = useRouter();
  const [season, setSeason] = useState<Season | null>(null);
  const [loading, setLoading] = useState(true);
  const [openWeek, setOpenWeek] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const data = await fetch(`/api/plans/season?userId=${user.id}`).then((r) =>
        r.json()
      );
      setSeason(data);
      if (data.currentWeek) setOpenWeek(data.currentWeek);
    } finally {
      setLoading(false);
    }
  }, [user]);

  async function expand(body: any, label: string) {
    if (!user) return;
    setBusy(label);
    setMessage("");
    try {
      const res = await fetch("/api/plans/expand", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, ...body }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      setMessage(
        data.generatedWeeks
          ? `Generated detailed sessions for ${data.generatedWeeks} week(s).`
          : data.message || "Nothing to generate."
      );
      await load();
    } catch (e: any) {
      setMessage(e.message || "Failed to generate sessions");
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      router.push("/login");
      return;
    }
    load();
  }, [user, authLoading, router, load]);

  if (authLoading || loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-gray-600">Loading your season...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 py-10 px-4">
      <div className="max-w-4xl mx-auto">
        <div className="flex justify-between items-center mb-6">
          <div>
            <h1 className="text-3xl font-bold text-indigo-900">Season plan</h1>
            {season?.hasPlan && (
              <p className="text-gray-600">
                {season.totalWeeks} weeks to race day
                {season.raceDate ? ` (${season.raceDate})` : ""} ·{" "}
                {season.detailedWeeks} weeks detailed
              </p>
            )}
          </div>
          <div className="flex gap-2">
            <Link href="/today" className="bg-indigo-600 text-white px-4 py-2 rounded-lg">
              Today
            </Link>
            <Link
              href="/profile"
              className="bg-white text-indigo-700 border border-indigo-300 px-4 py-2 rounded-lg"
            >
              Profile
            </Link>
          </div>
        </div>

        {!season?.hasPlan && (
          <div className="bg-white rounded-lg shadow p-8 text-center">
            <p className="text-gray-700 mb-4">You don&apos;t have a plan yet.</p>
            <Link
              href="/profile"
              className="inline-block bg-indigo-600 text-white px-6 py-3 rounded-lg font-semibold"
            >
              Generate my plan
            </Link>
          </div>
        )}

        {season?.hasPlan && (
          <>
            {message && (
              <div className="bg-blue-100 text-blue-900 px-4 py-3 rounded mb-4">
                {message}
              </div>
            )}

            {season.detailedWeeks < season.totalWeeks && (
              <div className="bg-white rounded-lg shadow p-4 mb-4 flex flex-wrap items-center justify-between gap-3">
                <p className="text-gray-700">
                  {season.totalWeeks - season.detailedWeeks} of{" "}
                  {season.totalWeeks} weeks are still outline-only.
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() =>
                      expand(
                        {
                          fromWeek: season.detailedWeeks + 1,
                          toWeek: Math.min(
                            season.detailedWeeks + 4,
                            season.totalWeeks
                          ),
                        },
                        "next4"
                      )
                    }
                    disabled={busy !== null}
                    className="bg-indigo-600 text-white px-4 py-2 rounded-lg disabled:opacity-50"
                  >
                    {busy === "next4" ? "Generating..." : "Detail next 4 weeks"}
                  </button>
                  <button
                    onClick={() => expand({ all: true }, "all")}
                    disabled={busy !== null}
                    className="bg-white text-indigo-700 border border-indigo-300 px-4 py-2 rounded-lg disabled:opacity-50"
                  >
                    {busy === "all"
                      ? "Generating all weeks..."
                      : "Detail all remaining weeks"}
                  </button>
                </div>
              </div>
            )}

            <div className="space-y-3">
            {season.weeks.map((w) => (
              <div
                key={w.week}
                className={`bg-white rounded-lg shadow ${
                  w.isCurrentWeek ? "ring-2 ring-indigo-500" : ""
                }`}
              >
                <button
                  onClick={() => setOpenWeek(openWeek === w.week ? null : w.week)}
                  className="w-full text-left p-4 flex justify-between items-center gap-4"
                >
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="font-bold text-indigo-900">
                      Week {w.week}
                    </span>
                    <span
                      className={`px-2 py-1 rounded text-sm font-semibold ${
                        phaseColor[w.phase] || "bg-gray-100 text-gray-700"
                      }`}
                    >
                      {w.phase}
                    </span>
                    {w.isCurrentWeek && (
                      <span className="px-2 py-1 rounded text-sm bg-indigo-600 text-white">
                        This week
                      </span>
                    )}
                    {w.isRaceWeek && <span className="text-sm">🏁 Race week</span>}
                    <span className="text-sm text-gray-500">{w.startDate}</span>
                  </div>
                  <div className="text-right text-sm text-gray-600 whitespace-nowrap">
                    {w.targetHours ? <div>{w.targetHours} h</div> : null}
                    {w.targetTss ? <div>{w.targetTss} TSS</div> : null}
                    {!w.hasDetail && (
                      <div className="text-gray-400">outline only</div>
                    )}
                  </div>
                </button>

                {openWeek === w.week && (
                  <div className="px-4 pb-4">
                    {w.focus && (
                      <p className="text-gray-700 mb-3">
                        <strong>Focus:</strong> {w.focus}
                      </p>
                    )}

                    {w.hasDetail ? (
                      <div className="space-y-2">
                        {w.sessions.map((s, i) => (
                          <div
                            key={i}
                            className="border border-gray-200 rounded p-3"
                          >
                            <div className="flex justify-between">
                              <p className="font-semibold text-gray-800">
                                {s.day} — {s.discipline}{" "}
                                <span className="text-indigo-600">{s.type}</span>
                              </p>
                              <p className="text-sm text-gray-500">
                                {s.duration} · TSS {s.tss}
                              </p>
                            </div>
                            {s.instructions && (
                              <p className="text-sm text-gray-700 mt-1">
                                {s.instructions}
                              </p>
                            )}
                            {s.pace && (
                              <p className="text-sm text-gray-500 mt-1">
                                Pace: {s.pace}
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div>
                        <p className="text-gray-500 text-sm mb-3">
                          This week is planned at a high level only. Generate the
                          day-by-day sessions whenever you want them.
                        </p>
                        <button
                          onClick={() =>
                            expand(
                              { fromWeek: w.week, toWeek: w.week },
                              `week-${w.week}`
                            )
                          }
                          disabled={busy !== null}
                          className="bg-indigo-600 text-white px-4 py-2 rounded-lg disabled:opacity-50"
                        >
                          {busy === `week-${w.week}`
                            ? "Generating..."
                            : `Generate sessions for week ${w.week}`}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

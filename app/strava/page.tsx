"use client";

import { useEffect, useState, useCallback } from "react";
import { useAuth } from "@/lib/auth-context";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

interface Activity {
  id: string;
  name: string;
  discipline: string;
  date: string;
  minutes: number;
  distanceKm: number;
  avgHeartRate: number | null;
  estimatedTss: number;
}

interface Status {
  configured: boolean;
  connected: boolean;
  athleteName: string | null;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  activityCount: number;
  history: any;
}

function StravaPageInner() {
  const { user, isLoading: authLoading } = useAuth();
  const params = useSearchParams();
  const [status, setStatus] = useState<Status | null>(null);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const s = await fetch(`/api/strava/status?userId=${user.id}`).then((r) =>
        r.json()
      );
      setStatus(s);
      if (s.connected || s.activityCount > 0) {
        const a = await fetch(`/api/strava/activities?userId=${user.id}`).then(
          (r) => r.json()
        );
        setActivities(a.activities || []);
      }
    } catch {
      setMessage("Could not load Strava status");
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (authLoading || !user) return;
    const err = params.get("error");
    const connected = params.get("connected");
    const imported = params.get("imported");
    if (err) setMessage(`Strava error: ${err}`);
    if (connected)
      setMessage(`Strava connected! Imported ${imported || 0} activities.`);
    load();
  }, [user, authLoading, load, params]);

  async function handleSync() {
    if (!user) return;
    setSyncing(true);
    setMessage("");
    try {
      const res = await fetch("/api/strava/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Sync failed");
      const parts = [`Synced: ${data.added} new activities added.`];
      if (data.reconciled > 0) {
        parts.push(`${data.reconciled} session${data.reconciled === 1 ? "" : "s"} updated to match.`);
      }
      if (data.adapted) parts.push("Plan adapted.");
      setMessage(parts.join(" "));
      await load();
    } catch (e: any) {
      setMessage(e.message || "Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  if (authLoading || loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-gray-600">Loading Strava...</p>
      </div>
    );
  }

  const h = status?.history;

  return (
    <div className="page-shell">
      <div className="page-inner">
        <header className="mb-8 sm:mb-10">
          <p className="eyebrow mb-3">Settings · Integration</p>
          <h1 className="page-title">Strava</h1>
        </header>

        {message && (
          <div className="alert alert-info mb-6">{message}</div>
        )}

        {/* Not configured */}
        {status && !status.configured && (
          <div className="card card-pad mb-6">
            <h2 className="section-title mb-2">
              Strava not configured yet
            </h2>
            <p className="text-gray-700">
              The app needs a Strava API key. Create an API application at{" "}
              <a
                className="text-indigo-600 underline"
                href="https://www.strava.com/settings/api"
                target="_blank"
                rel="noreferrer"
              >
                strava.com/settings/api
              </a>{" "}
              and add <code>STRAVA_CLIENT_ID</code> and{" "}
              <code>STRAVA_CLIENT_SECRET</code> to <code>.env.local</code>, then
              restart the server.
            </p>
          </div>
        )}

        {/* Connect / connected */}
        {status && status.configured && (
          <div className="card card-pad mb-6">
            {status.connected ? (
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <p className="text-green-700 font-semibold">
                    ✓ Connected{status.athleteName ? ` as ${status.athleteName}` : ""}
                  </p>
                  <p className="text-gray-600">
                    {status.activityCount} activities imported
                  </p>
                  {status.lastSyncedAt && (
                    <p className="text-sm text-gray-500">
                      Last automatic sync:{" "}
                      {new Date(status.lastSyncedAt).toLocaleString()}
                    </p>
                  )}
                  {status.lastSyncError && (
                    <p className="text-sm text-red-600">
                      Last sync error: {status.lastSyncError}
                    </p>
                  )}
                </div>
                <button
                  onClick={handleSync}
                  disabled={syncing}
                  className="btn btn-primary"
                >
                  {syncing ? "Syncing..." : "Sync now"}
                </button>
              </div>
            ) : (
              <div>
                <p className="text-gray-700 mb-4">
                  Connect Strava to import your real training history. Your plan
                  will then be based on what you actually do.
                </p>
                <a
                  href={`/api/strava/connect?userId=${user?.id}`}
                  className="btn btn-primary"
                >
                  Connect Strava
                </a>
              </div>
            )}
          </div>
        )}

        {/* History summary */}
        {h?.hasData && (
          <div className="card card-pad mb-6">
            <h2 className="section-title mb-4">
              Your training (last {h.weeksAnalysed} weeks)
            </h2>
            <div className="flex flex-wrap gap-8 mb-4">
              <div>
                <p className="meta">Avg per week</p>
                <p className="numeral">
                  {h.avgWeeklyHours} h
                </p>
              </div>
              <div>
                <p className="meta">Avg weekly load</p>
                <p className="numeral">
                  {h.avgWeeklyTss} TSS
                </p>
              </div>
              <div>
                <p className="meta">Activities</p>
                <p className="numeral">
                  {h.totalActivities}
                </p>
              </div>
            </div>
            <div className="space-y-1">
              {h.byDiscipline.map((d: any) => (
                <p key={d.discipline} className="text-gray-700">
                  <strong>{d.discipline}:</strong> {d.count} sessions ·{" "}
                  {d.totalHours} h · {d.totalDistanceKm} km · longest{" "}
                  {d.longestMinutes} min
                  {d.avgHeartRate ? ` · avg HR ${d.avgHeartRate}` : ""}
                </p>
              ))}
            </div>
          </div>
        )}

        {/* Activity list */}
        {activities.length > 0 && (
          <div className="card card-pad">
            <h2 className="section-title mb-4">
              Recent activities
            </h2>
            <div className="space-y-3">
              {activities.map((a) => (
                <div
                  key={a.id}
                  className="well flex justify-between gap-4 py-4"
                >
                  <div>
                    <p className="font-semibold text-gray-900 tracking-[-0.01em]">{a.name}</p>
                    <p className="meta mt-1">
                      {new Date(a.date).toLocaleDateString()} · {a.discipline}
                    </p>
                  </div>
                  <div className="text-right whitespace-nowrap font-mono text-[11px] tracking-[0.06em] text-gray-500 tabular-nums">
                    <p>
                      {a.minutes} min · {a.distanceKm} km
                    </p>
                    <p>
                      {a.avgHeartRate ? `HR ${Math.round(a.avgHeartRate)} · ` : ""}
                      ~{a.estimatedTss} TSS
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function StravaPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center">
          <p className="text-gray-600">Loading...</p>
        </div>
      }
    >
      <StravaPageInner />
    </Suspense>
  );
}

"use client";

import { useEffect, useState, useCallback } from "react";
import { useAuth } from "@/lib/auth-context";
import CoachChat from "@/components/CoachChat";
import CoachDecisions from "@/components/CoachDecisions";
import SessionPhases from "@/components/SessionPhases";
import SyncStravaButton from "@/components/SyncStravaButton";
import { EmptyState, Loading, MetricGrid, PageHeader, Stat } from "@/components/ui";
import Link from "next/link";

interface DaySession {
  id: string;
  discipline: string;
  type: string;
  duration: string;
  tss: number;
  actualTss: number | null;
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

const DISCIPLINE_STYLE: Record<string, string> = {
  Swim: "bg-sky-100 text-sky-800",
  Bike: "bg-amber-100 text-amber-800",
  Run: "bg-rose-100 text-rose-800",
  Strength: "bg-violet-100 text-violet-800",
};

const STATUS_BADGE: Record<string, string> = {
  completed: "badge-success",
  // It happened — whether it was on the plan or not makes no difference to
  // the athlete, so it reads the same as anything else they completed.
  unplanned: "badge-success",
  substituted: "badge-warn",
  missed: "badge-danger",
  skipped: "badge-muted",
  adapted: "badge-brand",
};

/** What the status badge says. Distinct from `STATUS_BADGE` (the styling)
 * because the raw status word ("unplanned") reads like the app doesn't know
 * what happened — the athlete only cares that it did. */
const STATUS_LABEL: Record<string, string> = {
  completed: "done",
  unplanned: "done",
  substituted: "trained something else",
};

export default function TodayPage() {
  const { user, isLoading: authLoading } = useAuth();
  const [view, setView] = useState<TodayView | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

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
    if (authLoading || !user) return;
    load();
  }, [user, authLoading, load]);

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

  if (authLoading || isLoading) {
    return <Loading label="Loading today's session..." />;
  }

  // The date belongs in the mono register: it is a reading, not a heading.
  const todayStamp = new Date()
    .toLocaleDateString(undefined, {
      weekday: "long",
      day: "2-digit",
      month: "short",
    })
    .toUpperCase();

  return (
    <div className="page-shell">
      <div className="page-inner-narrow">
        <PageHeader
          title="Today"
          eyebrow={todayStamp}
          actions={user && <SyncStravaButton userId={user.id} onSynced={load} />}
        />

        {error && <div className="alert alert-danger mb-6">{error}</div>}

        {/* No plan yet */}
        {view && !view.hasPlan && (
          <EmptyState
            title="No plan yet"
            body="Once your season is generated, this is where each day's session lands."
            action={
              <Link href="/profile" className="btn btn-primary btn-lg">
                Generate my plan
              </Link>
            }
          />
        )}

        {/* Week context */}
        {view && view.hasPlan && view.inPlanRange && (
          <div className="mb-6">
            <MetricGrid cols={3}>
              <Stat
                label="Week"
                value={view.week != null ? view.week : "—"}
                hint={view.phase ?? undefined}
              />
              <Stat
                label="Load · TSS"
                value={`${view.weekTssCompleted}/${view.weekTssPlanned}`}
              />
              {view.daysUntilRace !== null && view.daysUntilRace >= 0 ? (
                <Stat
                  label="Race in"
                  value={view.daysUntilRace}
                  hint="days"
                  signal
                />
              ) : (
                <Stat label="Race date" value={view.raceDate ?? "—"} text />
              )}
            </MetricGrid>
            {view.summary && (
              <div className="card card-pad mt-3">
                <p className="eyebrow mb-2.5">Coach</p>
                <p className="agent-voice-sm">{view.summary}</p>
              </div>
            )}
          </div>
        )}

        {/* Outside plan range */}
        {view && view.hasPlan && !view.inPlanRange && (
          <div className="card card-pad mb-6">
            <p className="text-gray-700">
              Today falls outside your current plan&apos;s date range. You can
              review the full plan or generate a new one.
            </p>
          </div>
        )}

        {/* Today's sessions */}
        {view && view.hasPlan && (
          <section className="mb-8">
            <h2 className="section-title mb-3">Today&apos;s session</h2>

            {view.sessions.length === 0 ? (
              <div className="card card-pad">
                <p className="meta meta-strong">Rest day</p>
                <p className="text-sm text-gray-600 mt-2">
                  Nothing scheduled for today. Recover well.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {view.sessions.map((s) => {
                  const expanded = expandedId === s.id;
                  return (
                    <article key={s.id} className="card">
                      <button
                        type="button"
                        onClick={() => setExpandedId(expanded ? null : s.id)}
                        aria-expanded={expanded}
                        className="w-full flex items-center justify-between gap-4 text-left p-4 sm:px-5"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <span
                            className={`badge ${DISCIPLINE_STYLE[s.discipline] ?? "badge-muted"}`}
                          >
                            {s.discipline}
                          </span>
                          <span className="text-sm font-semibold tracking-[-0.015em] text-gray-950 truncate">
                            {s.type}
                          </span>
                        </div>
                        <div className="flex items-center gap-3 shrink-0">
                          <span className="meta meta-strong">{s.duration}</span>
                          <span
                            aria-hidden="true"
                            className="text-[0.6rem] text-gray-400"
                          >
                            {expanded ? "—" : "+"}
                          </span>
                        </div>
                      </button>

                      {expanded && (
                        <div className="border-t border-gray-200 p-4 sm:p-5">
                          <div className="flex justify-between items-center gap-3 mb-4">
                            <p className="meta meta-strong">
                              {s.duration} /{" "}
                              {s.actualTss !== null ? s.actualTss : s.tss} TSS
                            </p>
                            {s.status !== "planned" && (
                              <span className={`badge ${STATUS_BADGE[s.status] ?? "badge-muted"}`}>
                                {STATUS_LABEL[s.status] ?? s.status}
                              </span>
                            )}
                          </div>

                          {s.instructions && (
                            <div className="well mb-4">
                              <SessionPhases instructions={s.instructions} />
                            </div>
                          )}
                          {s.pace && (
                            <div className="mb-5">
                              <p className="eyebrow mb-1.5">Pace / effort</p>
                              <p className="text-sm text-gray-700">{s.pace}</p>
                            </div>
                          )}

                          {/* Two choices only: you did it, or you're not doing it.
                              "Skip" and "Undo" side by side read as the same thing. */}
                          {s.status === "planned" ? (
                            <div className="flex gap-2">
                              <button
                                onClick={() => setStatus(s.id, "completed")}
                                disabled={busyId === s.id}
                                className="btn btn-success"
                              >
                                {busyId === s.id ? "Saving…" : "Completed"}
                              </button>
                              <button
                                onClick={() => setStatus(s.id, "skipped")}
                                disabled={busyId === s.id}
                                className="btn btn-secondary"
                              >
                                Discard
                              </button>
                            </div>
                          ) : (
                            <p className="meta">
                              {s.status === "completed" ? "Done" : "Discarded"}{" "}
                              <button
                                onClick={() => setStatus(s.id, "planned")}
                                disabled={busyId === s.id}
                                className="text-indigo-600 underline underline-offset-2 disabled:opacity-50"
                              >
                                change
                              </button>
                            </p>
                          )}
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {/* Judgement calls that are the athlete's to make, not the engine's. */}
        <CoachDecisions onChanged={load} />

        {/* Tell the coach what is going on, in your own words. */}
        <div className="mb-8">
          <CoachChat onChanged={load} />
        </div>

        {/* Tomorrow preview */}
        {view && view.hasPlan && (
          <section>
            <h2 className="section-title mb-3">Tomorrow</h2>
            {view.tomorrow.length === 0 ? (
              <div className="card card-pad">
                <p className="meta">Rest day</p>
              </div>
            ) : (
              <div className="space-y-2">
                {view.tomorrow.map((s) => (
                  <div
                    key={s.id}
                    className="card card-pad flex justify-between items-center gap-4"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-semibold tracking-[-0.015em] text-gray-950 truncate">
                        {s.discipline} / {s.type}
                      </p>
                      <p className="meta mt-1.5">{s.duration}</p>
                    </div>
                    <p className="meta meta-strong shrink-0">TSS {s.tss}</p>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

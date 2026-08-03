"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import Link from "next/link";
import PlanCalendar, {
  CalendarSession,
  CalendarWeek,
} from "@/components/PlanCalendar";
import UnsavedChangesGuard from "@/components/UnsavedChangesGuard";
import { warningsFor } from "@/lib/plan-warnings";
import {
  DraftState,
  emptyDraft,
  pushStep,
  positions,
  undo,
  redo,
  canUndo,
  canRedo,
  undoLabel,
  redoLabel,
  netMoves,
  isDirty,
  discardAll,
  resetWeekStep,
  weekIsDirty,
} from "@/lib/plan-draft";

interface SeasonSession {
  id: string;
  day: string;
  date: string;
  discipline: string;
  type: string;
  duration: string;
  tss: number;
  actualTss: number | null;
  load?: { metabolic: number; mechanical: number; neuromuscular: number; upper: number };
  instructions: string;
  pace: string;
  status: string;
  isAnchor: boolean;
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
  sessions: SeasonSession[];
}

interface Season {
  hasPlan: boolean;
  totalWeeks: number;
  detailedWeeks: number;
  raceDate: string | null;
  currentWeek: number | null;
  frozenUntil: string;
  weeks: SeasonWeek[];
}

export default function PlanPage() {
  const { user, isLoading: authLoading } = useAuth();
  const [season, setSeason] = useState<Season | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [openSession, setOpenSession] = useState<any>(null);
  const [draft, setDraft] = useState<DraftState>(emptyDraft({}));

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const data: Season = await fetch(
        `/api/plans/season?userId=${user.id}`
      ).then((r) => r.json());
      setSeason(data);
      // Reloading establishes a new baseline: whatever the server now says is
      // the truth, and any draft on top of it is stale.
      const baseline: Record<string, string> = {};
      for (const w of data.weeks ?? []) {
        for (const s of w.sessions) baseline[s.id] = s.date;
      }
      setDraft(emptyDraft(baseline));
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (authLoading || !user) return;
    load();
  }, [user, authLoading, load]);

  // ---- Draft-aware derived data ----------------------------------------

  /** Every session, moved to wherever the draft currently puts it. */
  const sessions: CalendarSession[] = useMemo(() => {
    if (!season) return [];
    const at = positions(draft);
    return season.weeks
      .flatMap((w) => w.sessions)
      .map((s) => ({
        id: s.id,
        discipline: s.discipline,
        type: s.type,
        duration: s.duration,
        tss: s.tss,
        actualTss: s.actualTss ?? null,
        status: s.status,
        isAnchor: s.isAnchor,
        instructions: s.instructions,
        pace: s.pace,
        load: s.load,
        date: at[s.id] ?? s.date,
      }));
  }, [season, draft]);

  /**
   * Which plan week a calendar day falls in. Derived from week 1's Monday so
   * it matches the server's arithmetic rather than guessing from the UI.
   */
  const weekOf = useCallback(
    (date: string): number => {
      const first = season?.weeks[0]?.startDate;
      if (!first) return 0;
      const [ay, am, ad] = first.split("-").map(Number);
      const [by, bm, bd] = date.split("-").map(Number);
      const days = Math.round(
        (Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000
      );
      return Math.floor(days / 7) + (season?.weeks[0]?.week ?? 1);
    },
    [season]
  );

  const dirtyWeeks = useMemo(() => {
    const out = new Set<number>();
    for (const w of season?.weeks ?? []) {
      if (weekIsDirty(draft, w.week, weekOf)) out.add(w.week);
    }
    return out;
  }, [season, draft, weekOf]);

  /**
   * Guardrail warnings for the layout as it stands right now, recomputed on
   * every drop rather than waiting for Save. Being told after committing that
   * an arrangement was risky is feedback arriving too late to act on.
   *
   * This is the same pure function the server runs at save time, so the live
   * warning and the authoritative one cannot disagree.
   */
  const warnings = useMemo(
    () =>
      warningsFor(
        sessions.map((s) => ({
          id: s.id,
          date: s.date,
          discipline: s.discipline,
          type: s.type,
          tss: s.tss,
          isAnchor: s.isAnchor,
          status: s.status,
        }))
      ),
    [sessions]
  );

  /** Days named in a warning, so the calendar can mark them. */
  const warningDates = useMemo(
    () => new Set(warnings.flatMap((w) => w.dates)),
    [warnings]
  );

  const dirty = isDirty(draft);

  const calendarWeeks: CalendarWeek[] = useMemo(
    () =>
      (season?.weeks ?? [])
        .filter((w): w is SeasonWeek & { startDate: string } => !!w.startDate)
        .map((w) => ({
          week: w.week,
          phase: w.phase,
          focus: w.focus,
          targetHours: w.targetHours,
          targetTss: w.targetTss,
          isRaceWeek: w.isRaceWeek,
          hasDetail: w.hasDetail,
          isCurrentWeek: w.isCurrentWeek,
          startDate: w.startDate,
        })),
    [season]
  );

  // ---- Actions ----------------------------------------------------------

  function handleMove(sessionId: string, toDate: string) {
    const s = sessions.find((x) => x.id === sessionId);
    if (!s) return;
    setMessage("");
    setDraft((d) =>
      pushStep(d, {
        label: `Moved ${s.discipline} to ${toDate}`,
        moves: [{ sessionId, from: s.date, to: toDate }],
      })
    );
  }

  function handleResetWeek(week: number) {
    setDraft((d) => pushStep(d, resetWeekStep(d, week, weekOf)));
  }

  const save = useCallback(async (): Promise<boolean> => {
    if (!user) return false;
    const moves = netMoves(draft);
    if (moves.length === 0) return true;

    setSaving(true);
    setMessage("");
    try {
      const res = await fetch("/api/plans/reschedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, moves }),
      });
      const data = await res.json();

      if (!res.ok) {
        // 409 means the plan itself disagrees — show why, and keep the draft
        // so the athlete can fix it rather than losing their work.
        const reasons = (data.rejected ?? [])
          .map((r: any) => r.reason)
          .join(" ");
        setMessage(reasons || data.error || "Couldn't save your changes.");
        return false;
      }

      setMessage(
        data.moved === 1
          ? "Saved. 1 session moved."
          : `Saved. ${data.moved} sessions moved.`
      );
      await load();
      return true;
    } catch (e: any) {
      setMessage(e.message || "Couldn't save your changes.");
      return false;
    } finally {
      setSaving(false);
    }
  }, [user, draft, load]);

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

  // ---- Render -----------------------------------------------------------

  if (authLoading || loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-gray-600">Loading your plan...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 pb-10">
      {/* Editing toolbar. Only appears once there is something to lose. */}
      {dirty && (
        <div className="sticky top-0 z-30 bg-white border-b border-indigo-200 shadow-sm">
          <div className="max-w-4xl mx-auto px-4 py-2 flex items-center gap-2">
            <span className="text-sm text-indigo-900 font-medium">
              {netMoves(draft).length} unsaved
            </span>
            {warnings.length > 0 && (
              <span
                title={warnings.map((w) => w.detail).join("\n")}
                className="text-sm text-amber-700 font-medium"
              >
                ⚠ {warnings.length}
              </span>
            )}
            <button
              onClick={() => setDraft(undo)}
              disabled={!canUndo(draft) || saving}
              title={undoLabel(draft) ?? "Nothing to undo"}
              aria-label="Undo"
              className="px-3 py-1.5 rounded-md border border-gray-300 disabled:opacity-40"
            >
              ↶
            </button>
            <button
              onClick={() => setDraft(redo)}
              disabled={!canRedo(draft) || saving}
              title={redoLabel(draft) ?? "Nothing to redo"}
              aria-label="Redo"
              className="px-3 py-1.5 rounded-md border border-gray-300 disabled:opacity-40"
            >
              ↷
            </button>
            <button
              onClick={() => setDraft(discardAll)}
              disabled={saving}
              className="ml-auto text-sm text-gray-600 px-2 py-1.5"
            >
              Discard
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="bg-indigo-600 text-white px-5 py-1.5 rounded-md font-semibold disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      )}

      <div className="max-w-4xl mx-auto px-4 py-6">
        <div className="mb-6">
          <h1 className="text-3xl font-bold text-indigo-900">Season plan</h1>
          {season?.hasPlan && (
            <p className="text-gray-600">
              {season.totalWeeks} weeks to race day
              {season.raceDate ? ` (${season.raceDate})` : ""} ·{" "}
              {season.detailedWeeks} weeks detailed
            </p>
          )}
          {season?.hasPlan && (
            <p className="text-sm text-gray-500 mt-1">
              Press and hold a session to move it to another day.
            </p>
          )}
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

            {warnings.length > 0 && (
              <div className="bg-amber-50 border border-amber-300 text-amber-900 px-4 py-3 rounded mb-4">
                <p className="font-semibold mb-1">
                  {dirty
                    ? "Worth knowing before you save:"
                    : "Worth knowing about this week:"}
                </p>
                <ul className="list-disc pl-5 space-y-1 text-sm">
                  {warnings.map((w, i) => (
                    <li key={i}>{w.detail}</li>
                  ))}
                </ul>
                <p className="text-xs mt-2 text-amber-800">
                  You can still save this — it&apos;s your call.
                </p>
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

            <p className="text-gray-500 text-sm mb-2">
              ★ marks a key session — what the week is for. The coach eases or
              moves other sessions before it touches one of those. Tap any
              session to see it in full; press and hold to move it.
            </p>

            <PlanCalendar
              onOpen={(sess) => setOpenSession(sess)}
              weeks={calendarWeeks}
              sessions={sessions}
              frozenUntil={season.frozenUntil}
              dirtyWeeks={dirtyWeeks}
              warningDates={warningDates}
              onMove={handleMove}
              onResetWeek={handleResetWeek}
              onExpandWeek={(week) =>
                expand({ fromWeek: week, toWeek: week }, `week-${week}`)
              }
              busyWeek={busy}
            />
          </>
        )}

        {/* Full detail for a tapped session. Plain sheet rather than a modal
            library — it only has to be readable and dismissable. */}
        {openSession && (
          <div
            className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center p-4 z-50"
            onClick={() => setOpenSession(null)}
          >
            <div
              className="bg-white rounded-lg shadow-lg max-w-lg w-full p-5 max-h-[85vh] overflow-y-auto"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex justify-between items-start mb-2">
                <div>
                  <h3 className="text-xl font-bold text-indigo-900">
                    {openSession.discipline}
                    {openSession.isAnchor && (
                      <span className="text-indigo-600" title="Key session"> ★</span>
                    )}
                  </h3>
                  <p className="text-gray-600">
                    {openSession.type} · {openSession.date}
                  </p>
                </div>
                <button
                  onClick={() => setOpenSession(null)}
                  className="text-gray-500 px-2"
                  aria-label="Close"
                >
                  ✕
                </button>
              </div>

              <p className="text-gray-700">
                {openSession.duration} · {openSession.tss} load
                {openSession.actualTss != null &&
                  openSession.actualTss !== openSession.tss && (
                    <span className="text-gray-500">
                      {" "}
                      (actually {openSession.actualTss})
                    </span>
                  )}
              </p>

              {openSession.load && (
                <div className="mt-3 border border-gray-200 rounded p-3">
                  <p className="font-semibold text-gray-800 mb-1">
                    What it costs you
                  </p>
                  <table className="w-full text-sm">
                    <tbody>
                      <tr>
                        <td className="text-gray-600 py-0.5">Aerobic</td>
                        <td className="text-gray-800 text-right">
                          {Math.round(openSession.load.metabolic)}
                        </td>
                      </tr>
                      <tr>
                        <td className="text-gray-600 py-0.5">
                          Impact <span className="text-gray-400">(legs, slow to clear)</span>
                        </td>
                        <td className="text-gray-800 text-right">
                          {Math.round(openSession.load.mechanical)}
                        </td>
                      </tr>
                      <tr>
                        <td className="text-gray-600 py-0.5">High intensity</td>
                        <td className="text-gray-800 text-right">
                          {Math.round(openSession.load.neuromuscular)}
                        </td>
                      </tr>
                      <tr>
                        <td className="text-gray-600 py-0.5">Upper body</td>
                        <td className="text-gray-800 text-right">
                          {Math.round(openSession.load.upper)}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                  <p className="text-gray-500 text-xs mt-2">
                    Two sessions with the same total can cost very different
                    things. An hour of running does roughly four times the impact
                    of two hours on the bike — that is what the coach limits, not
                    the headline number.
                  </p>
                </div>
              )}

              {openSession.isAnchor && (
                <p className="text-indigo-700 text-sm mt-2">
                  ★ Key session. The coach protects this one: it will ease or move
                  anything else in the week before touching it.
                </p>
              )}

              {openSession.instructions && (
                <div className="mt-4">
                  <p className="font-semibold text-gray-800 mb-1">The session</p>
                  <p className="text-gray-700 whitespace-pre-line">
                    {openSession.instructions}
                  </p>
                </div>
              )}

              {openSession.pace && (
                <div className="mt-4">
                  <p className="font-semibold text-gray-800 mb-1">Pace / effort</p>
                  <p className="text-gray-700">{openSession.pace}</p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <UnsavedChangesGuard
        when={dirty}
        onSave={save}
        saving={saving}
        message="You've moved sessions around but haven't saved them yet."
      />
    </div>
  );
}

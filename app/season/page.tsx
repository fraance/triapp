"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import Link from "next/link";
import PlanCalendar, {
  CalendarSession,
  CalendarWeek,
} from "@/components/PlanCalendar";
import SessionPhases from "@/components/SessionPhases";
import SyncStravaButton from "@/components/SyncStravaButton";
import InlineEditable from "@/components/InlineEditable";
import { didTrain } from "@/lib/session-status";
import UnsavedChangesGuard from "@/components/UnsavedChangesGuard";
import { EmptyState, Loading } from "@/components/ui";
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
  athleteNote: string | null;
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
  const [saveError, setSaveError] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftState>(emptyDraft({}));

  // ---- Editing what a session actually was -------------------------------
  const [savingExecuted, setSavingExecuted] = useState(false);
  const [executedError, setExecutedError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function openSessionDetail(sess: any) {
    setExecutedError(null);
    setOpenSession(sess);
  }

  // Save a single corrected field (title, duration, load or note) and let the
  // plan react. Kept separate from the draft-move machinery: only this modal
  // writes to the executed-session endpoint.
  async function saveExecutedField(patch: {
    actualTss?: number;
    athleteNote?: string;
    type?: string;
    duration?: string;
    difficulty?: string;
    bodyNote?: string;
  }) {
    if (!user || !openSession) return;
    setSavingExecuted(true);
    setExecutedError(null);
    try {
      const res = await fetch("/api/sessions/executed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: user.id,
          sessionId: openSession.id,
          ...patch,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not save.");
      setMessage(
        data.adapted
          ? "Saved. The rest of the plan has been adjusted to match."
          : "Saved."
      );
      await load();
    } catch (e: any) {
      setExecutedError(e.message || "Could not save.");
    } finally {
      setSavingExecuted(false);
    }
  }

  const ed = (patch: Record<string, string | number>) => {
    const cast: Parameters<typeof saveExecutedField>[0] = {};
    for (const [k, v] of Object.entries(patch)) {
      if (k === "actualTss") cast.actualTss = Number(v);
      else (cast as any)[k] = v;
    }
    void saveExecutedField(cast);
  };

  // Copy the full workout (discipline + type + instructions) so the athlete can
  // paste it into their watch or notes. Plain text, from data we already hold —
  // never a guess.
  async function copySession(sess: any) {
    const header = [sess.discipline, sess.type].filter(Boolean).join(" · ");
    const text = [header, sess.duration, sess.instructions]
      .filter(Boolean)
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable (permissions); fall back to a prompt so the
      // athlete still gets the text.
      window.prompt("Copy the workout:", text);
    }
  }

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
        athleteNote: s.athleteNote,
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
    setSaveError(null);
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
        const why = reasons || data.error || "Couldn't save your changes.";
        setMessage(why);
        setSaveError(why);
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
      const why = e.message || "Couldn't save your changes.";
      setMessage(why);
      setSaveError(why);
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
    return <Loading label="Loading your plan..." />;
  }

  return (
    <div className="page-shell">
      {/* Editing toolbar. Only appears once there is something to lose, and
          floats rather than clamping to the viewport edge. */}
      {dirty && (
        <div className="sticky top-3 z-30 mb-6">
          <div className="max-w-4xl mx-auto floating px-4 py-2 flex items-center gap-2">
            <span className="meta meta-strong">
              {netMoves(draft).length} unsaved
            </span>
            {warnings.length > 0 && (
              <span
                title={warnings.map((w) => w.detail).join("\n")}
                className="badge badge-warn"
              >
                ⚠ {warnings.length}
              </span>
            )}
            <button
              onClick={() => setDraft(undo)}
              disabled={!canUndo(draft) || saving}
              title={undoLabel(draft) ?? "Nothing to undo"}
              aria-label="Undo"
              className="btn btn-secondary btn-sm"
            >
              ↶
            </button>
            <button
              onClick={() => setDraft(redo)}
              disabled={!canRedo(draft) || saving}
              title={redoLabel(draft) ?? "Nothing to redo"}
              aria-label="Redo"
              className="btn btn-secondary btn-sm"
            >
              ↷
            </button>
            <button
              onClick={() => setDraft(discardAll)}
              disabled={saving}
              className="ml-auto btn btn-ghost btn-sm"
            >
              Discard
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="btn btn-primary btn-sm"
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      )}

        <div className="max-w-4xl mx-auto">
          <div className="mb-8 sm:mb-10 flex items-end justify-between gap-4 flex-wrap">
            <div>
              <p className="eyebrow mb-3">Plan · Full season</p>
              <h1 className="page-title">Season plan</h1>
            </div>
            {user && <SyncStravaButton userId={user.id} onSynced={load} />}
        </div>

        {!season?.hasPlan && (
          <EmptyState
            title="No plan yet"
            body="Generate a season and every week from here to race day appears in this view."
            action={
              <Link href="/profile" className="btn btn-primary btn-lg">
                Generate my plan
              </Link>
            }
          />
        )}

        {season?.hasPlan && (
          <>
            {message && (
              <div className="alert alert-info mb-4">{message}</div>
            )}

            {season.detailedWeeks < season.totalWeeks && (
              <div className="card card-pad mb-4 flex flex-wrap items-center justify-between gap-3">
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
                    className="btn btn-primary"
                  >
                    {busy === "next4" ? "Generating..." : "Detail next 4 weeks"}
                  </button>
                  <button
                    onClick={() => expand({ all: true }, "all")}
                    disabled={busy !== null}
                    className="btn btn-secondary"
                  >
                    {busy === "all"
                      ? "Generating all weeks..."
                      : "Detail all remaining weeks"}
                  </button>
                </div>
              </div>
            )}

            <PlanCalendar
              onOpen={(sess) => openSessionDetail(sess)}
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
            className="fixed inset-0 bg-gray-900/45 backdrop-blur-sm flex items-end sm:items-center justify-center p-4 z-50"
            onClick={() => setOpenSession(null)}
          >
            <div
              className="card max-w-lg w-full p-6 sm:p-7 max-h-[85vh] overflow-y-auto shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex justify-between items-start mb-4">
                <div>
                  <p className="eyebrow mb-2">Session detail</p>
                  <h3 className="section-title">
                    {openSession.discipline}
                    {openSession.isAnchor && (
                      <span className="text-indigo-600" title="Key session"> ★</span>
                    )}
                  </h3>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => void copySession(openSession)}
                    className="btn btn-ghost btn-sm"
                    aria-label="Copy workout description"
                  >
                    {copied ? "Copied ✓" : "Copy"}
                  </button>
                  <button
                    onClick={() => setOpenSession(null)}
                    className="btn btn-ghost btn-sm"
                    aria-label="Close"
                  >
                    ✕
                  </button>
                </div>
              </div>

              <p className="text-gray-700">
                <InlineEditable
                  value={openSession.duration ?? ""}
                  onSave={(v) => ed({ duration: v })}
                  placeholder="duration"
                  label="duration"
                />
                {" · "}
                <span className="inline-flex items-center gap-1">
                  <InlineEditable
                    value={String(
                      openSession.actualTss != null
                        ? openSession.actualTss
                        : openSession.tss
                    )}
                    onSave={(v) => ed({ actualTss: v })}
                    label="load"
                  />
                  <span>
                    {" "}
                    load
                    {openSession.actualTss != null &&
                      openSession.actualTss !== openSession.tss &&
                      openSession.tss > 0 && (
                        <span className="text-gray-500">
                          {" "}
                          (planned {openSession.tss})
                        </span>
                      )}
                  </span>
                </span>
              </p>

              {executedError && (
                <p className="text-sm text-red-600 mt-3">
                  {executedError}{" "}
                  <button
                    type="button"
                    onClick={() => setExecutedError(null)}
                    className="underline text-red-500"
                  >
                    dismiss
                  </button>
                </p>
              )}

{didTrain(openSession.status) && (
                <div className="mt-4">
                  <p className="eyebrow mb-3">What actually happened</p>
                  <div className="mb-2">
                    <p className="label">How hard was it, compared to planned?</p>
                    <InlineEditable
                      value={openSession.difficulty ?? ""}
                      onSave={(v) => ed({ difficulty: v })}
                      placeholder='e.g. "very hard" or "easy"'
                      label="how hard it felt"
                    />
                  </div>
                  <div className="mb-2">
                    <p className="label">What did you notice in the body?</p>
                    <InlineEditable
                      value={openSession.bodyNote ?? ""}
                      onSave={(v) => ed({ bodyNote: v })}
                      placeholder='e.g. "x,y,z was hurting"'
                      multiline
                      label="body note"
                    />
                  </div>
                  <InlineEditable
                    value={openSession.athleteNote ?? ""}
                    onSave={(v) => ed({ athleteNote: v })}
                    placeholder='e.g. "Did 3x3 instead of 6x3 — calf felt tight"'
                    multiline
                    label="what actually happened"
                  />
                  <p className="hint">
                    Edit any of the figures above: the duration or load.
                    The load number — not these notes — is what your training load
                    and the rest of the plan are calculated from, so adjust it
                    when the session cost more or less than planned. "How hard it
                    felt" and the body note help the coach read your fatigue;
                    they never change the load on their own. Enter adds a new
                    line in a note.
                  </p>
                </div>
              )}

              {openSession.instructions && (
                <div className="mt-4">
                  <p className="eyebrow mb-3">
                    {openSession.athleteNote ? "What was planned" : "The session"}
                  </p>
                  <SessionPhases instructions={openSession.instructions} />
                </div>
              )}

              {openSession.isAnchor && (
                <p className="text-indigo-700 text-sm mt-5 max-w-[54ch] leading-relaxed">
                  ★ Key session. The coach protects this one: it will ease or move
                  anything else in the week before touching it.
                </p>
              )}

              {openSession.load && (
                <div className="well mt-5">
                  <p className="eyebrow mb-3">What it costs you</p>
                  <table className="w-full text-sm">
                    <tbody>
                      <tr>
                        <td className="text-gray-600 py-1 text-sm">Aerobic</td>
                        <td className="text-right font-mono text-sm text-gray-900 tabular-nums">
                          {Math.round(openSession.load.metabolic)}
                        </td>
                      </tr>
                      <tr>
                        <td className="text-gray-600 py-1 text-sm">
                          Impact <span className="text-gray-400">(legs, slow to clear)</span>
                        </td>
                        <td className="text-right font-mono text-sm text-gray-900 tabular-nums">
                          {Math.round(openSession.load.mechanical)}
                        </td>
                      </tr>
                      <tr>
                        <td className="text-gray-600 py-1 text-sm">High intensity</td>
                        <td className="text-right font-mono text-sm text-gray-900 tabular-nums">
                          {Math.round(openSession.load.neuromuscular)}
                        </td>
                      </tr>
                      <tr>
                        <td className="text-gray-600 py-1 text-sm">Upper body</td>
                        <td className="text-right font-mono text-sm text-gray-900 tabular-nums">
                          {Math.round(openSession.load.upper)}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}

              {openSession.pace && (
                <div className="mt-4">
                  <p className="eyebrow mb-2">Pace / effort</p>
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
        error={saveError}
        message="You've moved sessions around but haven't saved them yet."
      />
    </div>
  );
}

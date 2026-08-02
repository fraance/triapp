"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The plan calendar: weeks contain days, days contain draggable sessions.
 *
 * Dragging is built on pointer events rather than HTML5 drag-and-drop, which
 * simply does not fire on touch devices — and this is an installable PWA that
 * athletes use on a phone. Pointer events give us one code path for mouse,
 * touch and stylus.
 *
 * A drag starts on a press-and-hold (250ms) rather than immediately, so that
 * an ordinary swipe still scrolls the page. Moving before the hold elapses is
 * treated as a scroll and cancels the drag outright.
 */

const HOLD_MS = 250;
/** Movement before the hold elapses that means "this is a scroll". */
const SCROLL_SLOP_PX = 8;

export interface CalendarSession {
  id: string;
  discipline: string;
  type: string;
  duration: string;
  tss: number;
  status: string;
  isAnchor: boolean;
  /** Current day in the draft, ISO yyyy-mm-dd. */
  date: string;
}

export interface CalendarWeek {
  week: number;
  phase: string;
  focus: string | null;
  targetHours: number | null;
  targetTss: number | null;
  isRaceWeek: boolean;
  hasDetail: boolean;
  isCurrentWeek: boolean;
  /** Monday, ISO yyyy-mm-dd. */
  startDate: string;
}

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const phaseColour: Record<string, string> = {
  Base: "bg-blue-100 text-blue-800",
  Build: "bg-orange-100 text-orange-800",
  Peak: "bg-red-100 text-red-800",
  Taper: "bg-purple-100 text-purple-800",
  Race: "bg-green-100 text-green-800",
  Recovery: "bg-gray-100 text-gray-700",
};

function addDaysISO(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d + n);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate()
  ).padStart(2, "0")}`;
}

function prettyDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  });
}

/** Training that has already happened is a record, not a plan. */
function isHistory(status: string): boolean {
  return status !== "planned" && status !== "adapted";
}

export default function PlanCalendar({
  weeks,
  sessions,
  frozenUntil,
  dirtyWeeks,
  warningDates,
  onMove,
  onResetWeek,
  onExpandWeek,
  busyWeek,
}: {
  weeks: CalendarWeek[];
  /** Every session, already positioned according to the current draft. */
  sessions: CalendarSession[];
  /** Days on or before this are committed and cannot be changed. */
  frozenUntil: string;
  dirtyWeeks: Set<number>;
  /** Days the guardrails have flagged, so the athlete can see where. */
  warningDates: Set<string>;
  onMove: (sessionId: string, toDate: string) => void;
  onResetWeek: (week: number) => void;
  onExpandWeek: (week: number) => void;
  busyWeek: string | null;
}) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [hoverDate, setHoverDate] = useState<string | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);

  // Mutable drag bookkeeping. Refs, not state, because pointermove fires far
  // too often to re-render on every event.
  const drag = useRef<{
    id: string;
    from: string;
    startX: number;
    startY: number;
    holdTimer: number | null;
    active: boolean;
  } | null>(null);

  const byDate = new Map<string, CalendarSession[]>();
  for (const s of sessions) {
    if (!byDate.has(s.date)) byDate.set(s.date, []);
    byDate.get(s.date)!.push(s);
  }

  const endDrag = useCallback(() => {
    if (drag.current?.holdTimer) window.clearTimeout(drag.current.holdTimer);
    drag.current = null;
    setDraggingId(null);
    setHoverDate(null);
    setGhost(null);
  }, []);

  // Listeners live on the window so a fast drag that outruns the card still
  // tracks, and so releasing outside the calendar still ends the drag.
  useEffect(() => {
    function onPointerMove(e: PointerEvent) {
      const d = drag.current;
      if (!d) return;

      if (!d.active) {
        const moved =
          Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY);
        // They're scrolling, not dragging. Give up on the drag.
        if (moved > SCROLL_SLOP_PX) endDrag();
        return;
      }

      e.preventDefault();
      setGhost({ x: e.clientX, y: e.clientY });

      const el = document
        .elementFromPoint(e.clientX, e.clientY)
        ?.closest("[data-drop-date]") as HTMLElement | null;
      const date = el?.dataset.dropDate ?? null;
      setHoverDate(date && date > frozenUntil ? date : null);
    }

    function onPointerUp() {
      const d = drag.current;
      if (d?.active && hoverDate && hoverDate !== d.from) {
        onMove(d.id, hoverDate);
      }
      endDrag();
    }

    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", endDrag);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", endDrag);
    };
  }, [hoverDate, onMove, endDrag, frozenUntil]);

  function startPress(e: React.PointerEvent, s: CalendarSession) {
    if (isHistory(s.status) || s.date <= frozenUntil) return;
    if (e.button !== 0 && e.pointerType === "mouse") return;

    const holdTimer = window.setTimeout(() => {
      if (!drag.current) return;
      drag.current.active = true;
      setDraggingId(s.id);
      setGhost({ x: e.clientX, y: e.clientY });
      // A short buzz confirms the card has detached, which is the only
      // feedback available on a phone where the finger covers the card.
      navigator.vibrate?.(15);
    }, HOLD_MS);

    drag.current = {
      id: s.id,
      from: s.date,
      startX: e.clientX,
      startY: e.clientY,
      holdTimer,
      active: false,
    };
  }

  const dragged = sessions.find((s) => s.id === draggingId) ?? null;

  return (
    <div className="space-y-4">
      {weeks.map((w) => {
        const days = Array.from({ length: 7 }, (_, i) =>
          addDaysISO(w.startDate, i)
        );
        const weekSessions = days.flatMap((d) => byDate.get(d) ?? []);
        const planned = weekSessions.reduce((sum, s) => sum + s.tss, 0);
        const done = weekSessions
          .filter((s) => isHistory(s.status) && s.status !== "skipped")
          .reduce((sum, s) => sum + s.tss, 0);

        return (
          <section
            key={w.week}
            className={`bg-white rounded-lg shadow ${
              w.isCurrentWeek ? "ring-2 ring-indigo-500" : ""
            }`}
          >
            {/* ---- Week header ---- */}
            <header className="p-4 border-b border-gray-100">
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <span className="font-bold text-indigo-900">Week {w.week}</span>
                <span
                  className={`px-2 py-0.5 rounded text-sm font-semibold ${
                    phaseColour[w.phase] || "bg-gray-100 text-gray-700"
                  }`}
                >
                  {w.phase}
                </span>
                {w.isCurrentWeek && (
                  <span className="px-2 py-0.5 rounded text-sm bg-indigo-600 text-white">
                    This week
                  </span>
                )}
                {w.isRaceWeek && <span className="text-sm">🏁 Race week</span>}
                <span className="text-sm text-gray-500">
                  {prettyDay(w.startDate)} – {prettyDay(days[6])}
                </span>

                {dirtyWeeks.has(w.week) && (
                  <button
                    onClick={() => onResetWeek(w.week)}
                    className="ml-auto text-sm text-indigo-700 border border-indigo-200 px-3 py-1 rounded-md"
                  >
                    Reset week
                  </button>
                )}
              </div>

              <div className="flex flex-wrap gap-4 text-sm text-gray-600">
                <span>
                  <strong className="text-indigo-900">{planned}</strong> TSS
                  planned
                  {w.targetTss ? (
                    <span className="text-gray-400"> / {w.targetTss} target</span>
                  ) : null}
                </span>
                {done > 0 && (
                  <span>
                    <strong className="text-green-700">{done}</strong> completed
                  </span>
                )}
                {w.targetHours ? <span>{w.targetHours} h</span> : null}
                {w.focus && <span className="text-gray-500">{w.focus}</span>}
              </div>
            </header>

            {/* ---- Day rows ---- */}
            {w.hasDetail ? (
              <div className="divide-y divide-gray-50">
                {days.map((date, i) => {
                  const items = byDate.get(date) ?? [];
                  const frozen = date <= frozenUntil;
                  const isTarget = hoverDate === date;
                  const flagged = warningDates.has(date);

                  return (
                    <div
                      key={date}
                      data-drop-date={date}
                      className={`flex gap-3 px-4 py-2 min-h-[3.5rem] transition-colors ${
                        isTarget
                          ? "bg-indigo-50 ring-2 ring-inset ring-indigo-400"
                          : frozen
                            ? "bg-gray-50"
                            : ""
                      }`}
                    >
                      <div className="w-16 shrink-0 pt-1">
                        <p
                          className={`text-sm font-semibold ${
                            frozen ? "text-gray-400" : "text-gray-700"
                          }`}
                        >
                          {DAY_LABELS[i]}
                        </p>
                        <p className="text-xs text-gray-400">
                          {date.slice(8)}
                        </p>
                      </div>

                      <div className="flex-1 flex flex-wrap gap-2 items-start">
                        {items.length === 0 ? (
                          <p
                            className={`text-sm pt-1 ${
                              isTarget ? "text-indigo-700" : "text-gray-400"
                            }`}
                          >
                            {isTarget
                              ? "Drop here"
                              : frozen
                                ? "Committed"
                                : "Rest day"}
                          </p>
                        ) : (
                          items.map((s) => {
                            const locked = isHistory(s.status) || frozen;
                            return (
                              <div
                                key={s.id}
                                onPointerDown={(e) => startPress(e, s)}
                                className={`rounded-lg border px-3 py-2 select-none ${
                                  draggingId === s.id
                                    ? "opacity-30 border-indigo-300"
                                    : locked
                                      ? "border-gray-200 bg-gray-50 cursor-not-allowed"
                                      : "border-gray-200 bg-white cursor-grab active:cursor-grabbing"
                                } ${flagged && !locked ? "border-amber-400 bg-amber-50" : ""}`}
                                style={{ touchAction: locked ? "auto" : "none" }}
                                title={
                                  locked
                                    ? isHistory(s.status)
                                      ? `Already ${s.status}`
                                      : "This day is already committed"
                                    : "Press and hold to move"
                                }
                              >
                                <p className="font-semibold text-sm text-gray-800">
                                  {s.discipline}
                                  {s.isAnchor && (
                                    <span title="Key session"> ★</span>
                                  )}
                                </p>
                                <p className="text-xs text-indigo-600">
                                  {s.type}
                                </p>
                                <p className="text-xs text-gray-500">
                                  {s.duration} · {s.tss} TSS
                                </p>
                                {isHistory(s.status) && (
                                  <p className="text-xs text-green-700 font-medium">
                                    {s.status}
                                  </p>
                                )}
                              </div>
                            );
                          })
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="p-4">
                <p className="text-gray-500 text-sm mb-3">
                  This week is planned at a high level only. Generate the
                  day-by-day sessions whenever you want them.
                </p>
                <button
                  onClick={() => onExpandWeek(w.week)}
                  disabled={busyWeek !== null}
                  className="bg-indigo-600 text-white px-4 py-2 rounded-lg disabled:opacity-50"
                >
                  {busyWeek === `week-${w.week}`
                    ? "Generating..."
                    : `Generate sessions for week ${w.week}`}
                </button>
              </div>
            )}
          </section>
        );
      })}

      {/* The card follows the finger, since the finger hides the original. */}
      {dragged && ghost && (
        <div
          className="fixed z-50 pointer-events-none rounded-lg border-2 border-indigo-500 bg-white shadow-xl px-3 py-2 -translate-x-1/2 -translate-y-1/2"
          style={{ left: ghost.x, top: ghost.y }}
        >
          <p className="font-semibold text-sm text-gray-800">
            {dragged.discipline}
          </p>
          <p className="text-xs text-indigo-600">{dragged.type}</p>
        </div>
      )}
    </div>
  );
}

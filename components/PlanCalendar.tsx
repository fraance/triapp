"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  didTrain,
  isSettled,
  isUpcoming,
  displayTss,
  completedTss,
} from "@/lib/session-status";

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
  /** Prescribed load. Zero for unplanned training, which was never prescribed. */
  tss: number;
  /** What it actually cost, once reconciled against Strava. */
  actualTss: number | null;
  status: string;
  isAnchor: boolean;
  /** Current day in the draft, ISO yyyy-mm-dd. */
  date: string;
  /** Carried through so tapping a session can show it in full. */
  instructions?: string;
  pace?: string;
  /** Cost split by kind — impact is what a runner has to recover from. */
  load?: { metabolic: number; mechanical: number; neuromuscular: number; upper: number };
  /** The athlete's own correction to what actually happened, if they gave one. */
  athleteNote?: string | null;
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

/**
 * A settled day cannot be rearranged — but "settled" is not "achieved".
 * Treating every non-planned status as history was what made missed sessions
 * render green and count towards completed load.
 */
function isLocked(status: string): boolean {
  return !isUpcoming(status);
}

/** How a settled session should read to the athlete. */
function outcomeStyle(status: string): { label: string; className: string } {
  switch (status) {
    case "completed":
      return { label: "done", className: "text-green-700" };
    // Whether it was on the plan or not makes no difference to the athlete —
    // it happened, so it reads the same as anything else they completed.
    case "unplanned":
      return { label: "done", className: "text-green-700" };
    case "substituted":
      return { label: "trained something else", className: "text-amber-700" };
    case "missed":
      return { label: "missed", className: "text-red-600" };
    case "skipped":
      return { label: "skipped", className: "text-gray-500" };
    default:
      return { label: status, className: "text-gray-500" };
  }
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
  onOpen,
}: {
  weeks: CalendarWeek[];
  /** Every session, already positioned according to the current draft. */
  sessions: CalendarSession[];
  /**
   * The engine's commitment window. It stops the ENGINE reshuffling imminent
   * days; it never stops the athlete. v3 §4.4 allows a manual override, and
   * today is not the past — being unable to move today's own session was
   * simply wrong.
   */
  frozenUntil: string;
  dirtyWeeks: Set<number>;
  /** Days the guardrails have flagged, so the athlete can see where. */
  warningDates: Set<string>;
  onMove: (sessionId: string, toDate: string) => void;
  /** Tapping a session opens its full detail. */
  onOpen?: (session: CalendarSession) => void;
  onResetWeek: (week: number) => void;
  onExpandWeek: (week: number) => void;
  busyWeek: string | null;
}) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [hoverDate, setHoverDate] = useState<string | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);
  /** Which weeks have their day-rows revealed. Only the current week by default. */
  const [openWeeks, setOpenWeeks] = useState<Set<number>>(
    () => new Set(weeks.filter((w) => w.isCurrentWeek).map((w) => w.week))
  );

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
    if (s.status === "missed") continue;
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
      // The athlete may drop onto any day, including today.
      setHoverDate(date ?? null);
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
    if (isLocked(s.status)) return;
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
        // Planned load is what was prescribed. Completed load is only what
        // the athlete actually trained, valued at what it actually cost —
        // previously this counted missed and skipped sessions as done.
        const planned = weekSessions.reduce((sum, s) => sum + s.tss, 0);
        const done = weekSessions.reduce((sum, s) => sum + completedTss(s), 0);
        const remaining = Math.max(0, (w.targetTss ?? planned) - planned);

        return (
          <section
            key={w.week}
            className={`card ${
              w.isCurrentWeek ? "ring-2 ring-indigo-500" : ""
            }`}
          >
            {/* ---- Week header ---- */}
            <header className="p-4 border-b border-gray-100">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() =>
                    setOpenWeeks((prev) => {
                      const next = new Set(prev);
                      next.has(w.week) ? next.delete(w.week) : next.add(w.week);
                      return next;
                    })
                  }
                  aria-expanded={openWeeks.has(w.week)}
                  className="flex items-center gap-2 text-left flex-1"
                >
                  <span className="text-gray-400 text-xs">
                    {openWeeks.has(w.week) ? "▾" : "▸"}
                  </span>
                  <span className="font-bold text-indigo-900">Week {w.week}</span>
                  {openWeeks.has(w.week) && (
                    <>
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
                      {w.isRaceWeek && (
                        <span className="text-sm">🏁 Race week</span>
                      )}
                    </>
                  )}
                  <span className="text-sm text-gray-500">
                    {prettyDay(w.startDate)} – {prettyDay(days[6])}
                  </span>
                </button>

                {dirtyWeeks.has(w.week) && openWeeks.has(w.week) && (
                  <button
                    onClick={() => onResetWeek(w.week)}
                    className="btn btn-secondary btn-sm"
                  >
                    Reset week
                  </button>
                )}
              </div>

              {openWeeks.has(w.week) && (
                <div className="mt-3 text-sm text-gray-600">
                  {w.targetTss ? (
                    <div>
                      <div className="relative h-2 rounded-full bg-gray-100 overflow-hidden">
                        <span
                          className="absolute inset-y-0 left-0 rounded-full bg-indigo-500"
                          style={{
                            width: `${Math.min(
                              100,
                              Math.max(0, ((w.targetTss - planned) / w.targetTss) * 100)
                            )}%`,
                          }}
                        />
                      </div>
                      <div className="flex justify-between mt-1.5">
                        <span>
                          <strong className="text-green-700">{done}</strong>{" "}
                          completed
                        </span>
                        <span>
                          <strong className="text-indigo-900">{remaining}</strong>{" "}
                          remaining
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div className="flex justify-between">
                      <span>
                        <strong className="text-green-700">{done}</strong>{" "}
                        completed
                      </span>
                      <span>
                        <strong className="text-indigo-900">{planned}</strong> TSS
                      </span>
                    </div>
                  )}
                  {w.targetHours ? (
                    <p className="text-xs text-gray-400 mt-1">
                      {w.targetHours} h target
                    </p>
                  ) : null}
                </div>
              )}
            </header>

            {/* ---- Day rows ---- */}
            {openWeeks.has(w.week) &&
              (w.hasDetail ? (
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
                            {isTarget ? "Drop here" : "Rest day"}
                          </p>
                        ) : (
                          items.map((s) => {
                            // Only a settled session is locked. A day inside
                            // the engine's freeze window is still the
                            // athlete's to rearrange.
                            const locked = isLocked(s.status);
                            return (
                              <div
                                key={s.id}
                                onPointerDown={(e) => startPress(e, s)}
                                onClick={() => {
                                  // A drag suppresses the click, so this only
                                  // fires on a genuine tap.
                                  if (!draggingId) onOpen?.(s);
                                }}
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
                                    ? `Already ${s.status}`
                                    : "Press and hold to move · tap for detail"
                                }
                              >
                                <p className="font-semibold text-sm text-gray-800">
                                  {s.discipline}
                                  {s.isAnchor && (
                                    <span className="text-indigo-600">
                                      {" "}
                                      ★
                                    </span>
                                  )}
                                </p>
                                <p className="text-xs text-indigo-600">
                                  {s.type}
                                </p>
                                <p className="text-xs text-gray-500">
                                  {s.duration} · {displayTss(s)} TSS
                                  {didTrain(s.status) &&
                                    s.actualTss !== null &&
                                    s.tss > 0 &&
                                    s.actualTss !== s.tss && (
                                      <span className="text-gray-400">
                                        {" "}
                                        (planned {s.tss})
                                      </span>
                                    )}
                                </p>
                                {isSettled(s.status) && (
                                  <p
                                    className={`text-xs font-medium ${outcomeStyle(s.status).className}`}
                                  >
                                    {outcomeStyle(s.status).label}
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
                  className="btn btn-primary"
                >
                  {busyWeek === `week-${w.week}`
                    ? "Generating..."
                    : `Generate sessions for week ${w.week}`}
                </button>
              </div>
            ))}
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

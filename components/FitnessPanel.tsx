"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";

/**
 * Fitness: what the coach believes about your body, and why.
 *
 * Lives on the Athlete page rather than its own route: the nav allows no
 * orphan pages and no more than four sub-items per tab, and "Me" is full.
 * This is athlete data anyway.
 *
 * Deliberately plain. Its job is to make the engine's physiological reasoning
 * checkable — how much it trusts each number, what it thinks the race demands,
 * and any test it is asking for — not to look good.
 */

interface Threshold {
  kind: string;
  label: string;
  unit: string;
  value: number | null;
  confidence: number;
  useRpe: boolean;
  needsTest: boolean;
  basis: string;
  measuredAt: string | null;
  source: string | null;
  manualProtocol: ManualProtocol | null;
}

interface ManualProtocol {
  name: string;
  why: string;
  steps: string[];
  fields: Array<{ key: string; label: string; unit: string; hint?: string }>;
}

interface ScheduledTest {
  id: string;
  date: string | null;
  discipline: string;
  testKind: string | null;
  testMode: string | null;
  duration: string;
  instructions: string | null;
  manualProtocol: ManualProtocol | null;
}

/** Values are stored in different units; show them the way a coach would. */
function formatValue(t: Threshold): string {
  if (t.value == null) return "not set";
  if (t.unit === "sec/100m" || t.unit === "sec/km") {
    const m = Math.floor(t.value / 60);
    const s = Math.round(t.value % 60);
    return `${m}:${String(s).padStart(2, "0")} ${t.unit.replace("sec", "min")}`;
  }
  return `${t.value} ${t.unit}`;
}

/** How much the engine trusts a number, as a soft status tint. */
function confidenceBadge(c: number): string {
  if (c >= 0.7) return "badge-success";
  if (c >= 0.4) return "badge-warn";
  return "badge-danger";
}

/** The fill colour of the confidence meter. Muted — it informs, it doesn't alarm. */
function confidenceBar(c: number): string {
  if (c >= 0.7) return "bg-green-500";
  if (c >= 0.4) return "bg-amber-400";
  return "bg-red-500";
}

export default function FitnessPanel() {
  const { user } = useAuth();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [entry, setEntry] = useState<Record<string, Record<string, string>>>({});
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const res = await fetch(`/api/athlete/fitness?userId=${user.id}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load");
      setData(json);
      setError("");
    } catch (e: any) {
      setError(e.message);
    }
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  async function submitManual(kind: string, sessionId?: string) {
    if (!user) return;
    setBusy(kind);
    setMessage("");
    try {
      const res = await fetch("/api/thresholds/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: user.id,
          kind,
          sessionId,
          inputs: entry[kind] ?? {},
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not save");
      setMessage(
        json.outcome === "suggested"
          ? `Saved. ${json.reason}`
          : `${json.value} recorded — ${json.method}.`
      );
      setEntry((e) => ({ ...e, [kind]: {} }));
      await load();
    } catch (e: any) {
      setMessage(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function skip(kind: string, sessionId?: string) {
    if (!user) return;
    setBusy(kind);
    setMessage("");
    try {
      const res = await fetch("/api/thresholds/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, kind, sessionId, action: "skip" }),
      });
      const json = await res.json();
      setMessage(json.message || "Skipped.");
      await load();
    } catch (e: any) {
      setMessage(e.message);
    } finally {
      setBusy(null);
    }
  }

  if (!data) {
    return <p className="text-gray-600">{error || "Loading fitness…"}</p>;
  }

  const { thresholds, tests, limiters, metabolic } = data;

  return (
    <div>
      <p className="eyebrow mb-3">Physiology · Derived</p>
      <h2 className="page-title">Fitness</h2>
      <p className="page-subtitle mb-9">
        What the coach believes about your body, and how much it trusts each
        number.
      </p>

      {message && <div className="alert alert-info mb-7">{message}</div>}

      {/* ---- Tests the engine is asking for ---- */}
      {tests.length > 0 && (
        <div className="mb-10">
          <h3 className="section-title mb-4">Tests scheduled</h3>
          <div className="space-y-3">
            {tests.map((t: ScheduledTest) => (
              <div key={t.id} className="card card-pad">
                <p className="meta meta-strong">
                  {t.date} · {t.discipline} · {t.duration}
                </p>
                {t.instructions && (
                  <p className="text-gray-700 text-[15px] leading-relaxed mt-2.5">
                    {t.instructions}
                  </p>
                )}
                {t.manualProtocol && t.testKind && (
                  <ManualEntry
                    kind={t.testKind}
                    protocol={t.manualProtocol}
                    entry={entry}
                    setEntry={setEntry}
                    busy={busy === t.testKind}
                    onSubmit={() => submitManual(t.testKind!, t.id)}
                    onSkip={() => skip(t.testKind!, t.id)}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ---- Threshold confidence ----
          Every number carries its confidence, its source and its basis. The
          engine showing its working is what makes it checkable. */}
      <h3 className="section-title mb-4">Your numbers</h3>
      <div className="space-y-3 mb-10">
        {thresholds.map((t: Threshold) => (
          <div key={t.kind} className="card card-pad">
            <div className="flex justify-between items-start gap-4">
              <div className="min-w-0">
                <p className="meta">{t.label}</p>
                <p className="numeral mt-1.5">{formatValue(t)}</p>
              </div>
              <div className="text-right shrink-0">
                <span className={`badge ${confidenceBadge(t.confidence)}`}>
                  {Math.round(t.confidence * 100)}% confident
                </span>
                {t.source && (
                  <p className="meta mt-2">from {t.source}</p>
                )}
              </div>
            </div>

            {/* Confidence meter: the trust level, made visible. */}
            <div
              className="mt-4 h-1 rounded-full bg-gray-100 overflow-hidden"
              role="presentation"
            >
              <span
                className={`block h-full rounded-full ${confidenceBar(t.confidence)}`}
                style={{ width: `${Math.round(t.confidence * 100)}%` }}
              />
            </div>

            <p className="hint">{t.basis}</p>

            {t.useRpe && t.value != null && (
              <div className="alert alert-warn mt-4">
                Too old to prescribe from — sessions are being set by feel
                instead.
              </div>
            )}

            {(t.needsTest || t.value == null) && t.manualProtocol && (
              <details className="mt-4">
                <summary className="text-indigo-700 cursor-pointer text-sm font-semibold">
                  Measure it yourself
                </summary>
                <ManualEntry
                  kind={t.kind}
                  protocol={t.manualProtocol}
                  entry={entry}
                  setEntry={setEntry}
                  busy={busy === t.kind}
                  onSubmit={() => submitManual(t.kind)}
                  onSkip={() => skip(t.kind)}
                />
              </details>
            )}
          </div>
        ))}
      </div>

      {/* ---- Where race time is won ---- */}
      <h3 className="section-title mb-4">Where your race time is</h3>
      <div className="card card-pad mb-10">
        {limiters.hasData ? (
          <>
            <table className="w-full">
              <thead>
                <tr className="text-left">
                  <th className="meta pb-3 font-medium">Discipline</th>
                  <th className="meta pb-3 font-medium">Predicted</th>
                  <th className="meta pb-3 font-medium">5% gain saves</th>
                </tr>
              </thead>
              <tbody>
                {limiters.estimates.map((e: any) => (
                  <tr key={e.discipline} className="border-t border-gray-100">
                    <td className="py-3 text-gray-900 font-semibold capitalize">
                      {e.discipline}
                      {limiters.ranked[0] === e.discipline && (
                        <span className="badge badge-brand ml-2">
                          Biggest lever
                        </span>
                      )}
                    </td>
                    <td className="py-3 font-mono text-sm text-gray-700 tabular-nums">
                      {e.predictedSec
                        ? `${Math.floor(e.predictedSec / 3600)}h${String(
                            Math.floor((e.predictedSec % 3600) / 60)
                          ).padStart(2, "0")}`
                        : "—"}
                    </td>
                    <td className="py-3 font-mono text-sm text-gray-700 tabular-nums">
                      {e.minutesPer5Pct != null ? `${e.minutesPer5Pct} min` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {limiters.notes.map((n: string, i: number) => (
              <p key={i} className="hint">
                {n}
              </p>
            ))}
          </>
        ) : (
          <p className="text-gray-600">
            {limiters.notes[0] ?? "Not enough measured data yet."}
          </p>
        )}
      </div>

      {/* ---- Fuelling ---- */}
      <h3 className="section-title mb-4">Fuelling</h3>
      <div className="card card-pad">
        <p className="meta">Estimated glycogen</p>
        <p className="numeral mt-1.5">
          {Math.round(metabolic.glycogen * 100)}%
          <span className="ml-2 text-base font-normal text-gray-500">
            {metabolic.band}
          </span>
        </p>
        <p className="hint">{metabolic.basis}</p>
        <p className="hint">
          An estimate from training load, not a measurement — we hold no
          nutrition data.
        </p>
      </div>
    </div>
  );
}

/** The hand-capture form: instructions, the fields, and a way out. */
function ManualEntry({
  kind,
  protocol,
  entry,
  setEntry,
  busy,
  onSubmit,
  onSkip,
}: {
  kind: string;
  protocol: ManualProtocol;
  entry: Record<string, Record<string, string>>;
  setEntry: (fn: (e: any) => any) => void;
  busy: boolean;
  onSubmit: () => void;
  onSkip: () => void;
}) {
  return (
    <div className="well mt-4">
      <p className="font-semibold text-gray-900 tracking-[-0.01em]">
        {protocol.name}
      </p>
      <p className="text-gray-600 text-sm mt-1.5 leading-relaxed">
        {protocol.why}
      </p>
      <ol className="mt-4 space-y-2">
        {protocol.steps.map((s, i) => (
          <li key={i} className="flex gap-3 items-start">
            <span
              aria-hidden="true"
              className="shrink-0 w-5 h-5 mt-0.5 rounded-full bg-white text-gray-500
                font-mono text-[10px] font-semibold flex items-center justify-center"
            >
              {i + 1}
            </span>
            <span className="text-gray-700 text-sm leading-relaxed">{s}</span>
          </li>
        ))}
      </ol>

      <div className="mt-5 space-y-4">
        {protocol.fields.map((f) => (
          <div key={f.key}>
            <label className="label">{f.label}</label>
            <input
              className="input"
              placeholder={f.hint ?? ""}
              value={entry[kind]?.[f.key] ?? ""}
              onChange={(ev) =>
                setEntry((e: any) => ({
                  ...e,
                  [kind]: { ...(e[kind] ?? {}), [f.key]: ev.target.value },
                }))
              }
            />
          </div>
        ))}
      </div>

      <div className="flex gap-2.5 mt-5">
        <button onClick={onSubmit} disabled={busy} className="btn btn-primary">
          {busy ? "Saving…" : "Save result"}
        </button>
        <button onClick={onSkip} disabled={busy} className="btn btn-secondary">
          Skip this test
        </button>
      </div>
    </div>
  );
}

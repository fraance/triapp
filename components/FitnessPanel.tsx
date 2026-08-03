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

function confidenceColour(c: number): string {
  if (c >= 0.7) return "text-green-700";
  if (c >= 0.4) return "text-amber-700";
  return "text-red-700";
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
      <div>
        <h2 className="text-2xl font-bold text-indigo-900 mb-2">Fitness</h2>
        <p className="text-gray-600 mb-6">
          What the coach believes about your body, and how much it trusts each
          number.
        </p>

        {message && (
          <div className="bg-white border border-indigo-300 rounded p-3 mb-6">
            <p className="text-gray-800">{message}</p>
          </div>
        )}

        {/* ---- Tests the engine is asking for ---- */}
        {tests.length > 0 && (
          <div className="mb-8">
            <h3 className="text-lg font-bold text-indigo-900 mb-3">
              Tests scheduled
            </h3>
            {tests.map((t: ScheduledTest) => (
              <div key={t.id} className="bg-white rounded-lg shadow p-4 mb-3">
                <p className="font-semibold text-gray-800">
                  {t.date} · {t.discipline} · {t.duration}
                </p>
                {t.instructions && (
                  <p className="text-gray-700 text-sm mt-2">{t.instructions}</p>
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
        )}

        {/* ---- Threshold confidence ---- */}
        <h3 className="text-lg font-bold text-indigo-900 mb-3">
          Your numbers
        </h3>
        <div className="space-y-3 mb-8">
          {thresholds.map((t: Threshold) => (
            <div key={t.kind} className="bg-white rounded-lg shadow p-4">
              <div className="flex justify-between items-start">
                <div>
                  <p className="font-semibold text-gray-800">{t.label}</p>
                  <p className="text-gray-700">{formatValue(t)}</p>
                </div>
                <div className="text-right">
                  <p className={`font-semibold ${confidenceColour(t.confidence)}`}>
                    {Math.round(t.confidence * 100)}% confident
                  </p>
                  {t.source && (
                    <p className="text-gray-400 text-xs">from {t.source}</p>
                  )}
                </div>
              </div>
              <p className="text-gray-500 text-sm mt-1">{t.basis}</p>

              {t.useRpe && t.value != null && (
                <p className="text-amber-700 text-sm mt-2">
                  Too old to prescribe from — sessions are being set by feel
                  instead.
                </p>
              )}

              {(t.needsTest || t.value == null) && t.manualProtocol && (
                <details className="mt-3">
                  <summary className="text-indigo-700 cursor-pointer text-sm">
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
        <h3 className="text-lg font-bold text-indigo-900 mb-3">
          Where your race time is
        </h3>
        <div className="bg-white rounded-lg shadow p-4 mb-8">
          {limiters.hasData ? (
            <>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500">
                    <th className="pb-2">Discipline</th>
                    <th className="pb-2">Predicted</th>
                    <th className="pb-2">5% gain saves</th>
                  </tr>
                </thead>
                <tbody>
                  {limiters.estimates.map((e: any) => (
                    <tr key={e.discipline} className="border-t border-gray-100">
                      <td className="py-2 text-gray-800 capitalize">
                        {e.discipline}
                        {limiters.ranked[0] === e.discipline && (
                          <span className="text-indigo-700 text-xs"> · biggest lever</span>
                        )}
                      </td>
                      <td className="py-2 text-gray-700">
                        {e.predictedSec
                          ? `${Math.floor(e.predictedSec / 3600)}h${String(
                              Math.floor((e.predictedSec % 3600) / 60)
                            ).padStart(2, "0")}`
                          : "—"}
                      </td>
                      <td className="py-2 text-gray-700">
                        {e.minutesPer5Pct != null ? `${e.minutesPer5Pct} min` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {limiters.notes.map((n: string, i: number) => (
                <p key={i} className="text-gray-500 text-xs mt-2">
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
        <h3 className="text-lg font-bold text-indigo-900 mb-3">Fuelling</h3>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-gray-800">
            Estimated glycogen: {Math.round(metabolic.glycogen * 100)}% ·{" "}
            {metabolic.band}
          </p>
          <p className="text-gray-500 text-sm mt-1">{metabolic.basis}</p>
          <p className="text-gray-400 text-xs mt-2">
            An estimate from training load, not a measurement — we hold no
            nutrition data.
          </p>
        </div>
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
    <div className="mt-3 border-t border-gray-100 pt-3">
      <p className="font-semibold text-gray-800">{protocol.name}</p>
      <p className="text-gray-600 text-sm mt-1">{protocol.why}</p>
      <ol className="list-decimal list-inside text-gray-700 text-sm mt-2 space-y-1">
        {protocol.steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>

      <div className="mt-3 space-y-2">
        {protocol.fields.map((f) => (
          <div key={f.key}>
            <label className="block text-sm text-gray-700">{f.label}</label>
            <input
              className="border border-gray-300 rounded px-3 py-2 w-full"
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

      <div className="flex gap-2 mt-3">
        <button
          onClick={onSubmit}
          disabled={busy}
          className="bg-indigo-600 text-white px-4 py-2 rounded-lg disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save result"}
        </button>
        <button
          onClick={onSkip}
          disabled={busy}
          className="bg-white text-gray-700 border border-gray-300 px-4 py-2 rounded-lg disabled:opacity-50"
        >
          Skip this test
        </button>
      </div>
    </div>
  );
}

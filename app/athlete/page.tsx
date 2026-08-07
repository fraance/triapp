"use client";

import { useEffect, useState, useCallback } from "react";
import { useAuth } from "@/lib/auth-context";
import { toDateInput } from "@/lib/date-input";
import FitnessPanel from "@/components/FitnessPanel";
import { useRouter } from "next/navigation";
import Link from "next/link";

/** Small helper for a labelled input. */
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="label">
        {label}
      </label>
      {children}
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}

const input = "input";

/** Converts "mm:ss" or "h:mm:ss" to seconds, and back. */
function toSeconds(text: string): number | null {
  if (!text) return null;
  const parts = text.split(":").map((p) => parseInt(p, 10));
  if (parts.some(isNaN)) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}
function fromSeconds(sec?: number | null): string {
  if (!sec) return "";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

export default function AthletePage() {
  const { user, isLoading: authLoading } = useAuth();
  const router = useRouter();
  const [p, setP] = useState<any>({});
  const [snapshot, setSnapshot] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncingPbs, setSyncingPbs] = useState(false);
  const [prefilling, setPrefilling] = useState(false);
  const [prefilled, setPrefilled] = useState<any[]>([]);
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [resolving, setResolving] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const [profile, snap, sugg] = await Promise.all([
        fetch(`/api/profile?userId=${user.id}`).then((r) => r.json()),
        fetch(`/api/athlete/snapshot?userId=${user.id}`).then((r) => r.json()),
        fetch(`/api/athlete/suggestions?userId=${user.id}`).then((r) => r.json()),
      ]);
      setP(profile || {});
      setSnapshot(snap);
      setSuggestions(sugg.suggestions || []);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (authLoading || !user) return;
    load();
  }, [user, authLoading, load]);

  const set = (k: string, v: any) => setP((prev: any) => ({ ...prev, [k]: v }));
  const numOrNull = (v: string) => (v === "" ? null : parseFloat(v));

  async function prefill() {
    if (!user) return;
    setPrefilling(true);
    setMessage("");
    try {
      const res = await fetch("/api/athlete/prefill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Prefill failed");
      setPrefilled(data.applied || []);
      const conflicts = data.conflicts?.length ?? 0;
      setMessage(
        [
          data.applied?.length
            ? `Filled in ${data.applied.length} blank field(s) from your data.`
            : "No blank fields left to fill.",
          conflicts
            ? `${conflicts} value(s) differ from what you entered — see below and choose.`
            : "",
        ]
          .filter(Boolean)
          .join(" ")
      );
      await load();
    } catch (e: any) {
      setMessage(e.message || "Prefill failed");
    } finally {
      setPrefilling(false);
    }
  }

  async function resolve(field: string, decision: "accept" | "dismiss") {
    if (!user) return;
    setResolving(field);
    try {
      await fetch("/api/athlete/suggestions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, field, decision }),
      });
      await load();
    } finally {
      setResolving(null);
    }
  }

  async function syncPbs() {
    if (!user) return;
    setSyncingPbs(true);
    setMessage("");
    try {
      const res = await fetch("/api/athlete/personal-bests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Sync failed");
      setMessage(
        data.updated?.length
          ? `Pulled from Strava: ${data.updated.join(", ")}.${data.remaining ? ` ${data.remaining} runs left to scan — press again to continue.` : ""}`
          : `No new personal bests found.${data.warning ? ` (${data.warning})` : ""}`
      );
      await load();
    } catch (e: any) {
      setMessage(e.message || "Sync failed");
    } finally {
      setSyncingPbs(false);
    }
  }

  async function save() {
    if (!user) return;
    setSaving(true);
    setMessage("");
    try {
      const res = await fetch("/api/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, ...p }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Save failed");
      setMessage("Saved. Your coach will use this from now on.");
      await load();
      setTimeout(() => setMessage(""), 5000);
    } catch (e: any) {
      setMessage(e.message || "Save failed");
    } finally {
      setSaving(false);
    }
  }

  if (authLoading || loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-gray-600">Loading your athlete profile...</p>
      </div>
    );
  }

  const m = snapshot?.metrics;
  const eq = snapshot?.equipment;

  const detected = (metric: any, fmt?: (v: number) => string) => {
    if (!metric || metric.value === null) return null;
    if (metric.source === "measured") return null;
    return `Detected: ${fmt ? fmt(metric.value) : metric.value}`;
  };

  return (
    <div className="page-shell">
      <div className="page-inner">
        <header className="mb-8 sm:mb-10">
          <p className="eyebrow mb-3">Me · Profile</p>
          <h1 className="page-title">Athlete profile</h1>
          <p className="page-subtitle">
            Everything here makes your plan more accurate. Leave anything blank
            — we&apos;ll estimate it from your data or test for it.
          </p>
        </header>

        {message && (
          <div className="alert alert-success mb-6">{message}</div>
        )}

        {/* A conflict is never resolved silently: the athlete's value stands
            until they say otherwise, and both origins are labelled. */}
        {suggestions.length > 0 && (
          <div className="rounded-[2rem] bg-amber-50 p-6 sm:p-8 mb-6 shadow-sm">
            <p className="eyebrow mb-3">Conflict · Needs your call</p>
            <h2 className="section-title">We found different numbers to yours</h2>
            <p className="section-subtitle mt-2 mb-6">
              Your value stays unless you choose otherwise. We won&apos;t ask
              again once you&apos;ve decided.
            </p>
            <div className="space-y-3">
              {suggestions.map((sg: any) => (
                <div
                  key={sg.field}
                  className="bg-white rounded-2xl p-5 flex flex-wrap items-center justify-between gap-4"
                >
                  <div className="min-w-0">
                    <p className="meta">{sg.label}</p>
                    <p className="text-[15px] text-gray-800 mt-1.5">
                      You entered <strong>{sg.currentDisplay}</strong> · we found{" "}
                      <strong>{sg.suggestedDisplay}</strong>
                    </p>
                    <p className="hint">{sg.origin}</p>
                  </div>
                  <div className="flex gap-2 whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => resolve(sg.field, "accept")}
                      disabled={resolving === sg.field}
                      className="btn btn-primary btn-sm"
                    >
                      Use {sg.suggestedDisplay}
                    </button>
                    <button
                      type="button"
                      onClick={() => resolve(sg.field, "dismiss")}
                      disabled={resolving === sg.field}
                      className="btn btn-secondary btn-sm"
                    >
                      Keep mine
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="card card-pad mb-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0">
              <h2 className="section-title">Fill this in for me</h2>
              <p className="section-subtitle mt-2 max-w-[52ch]">
                Pulls your weight, FTP, sex, thresholds and personal bests from
                Strava and your training history. Anything you typed yourself is
                left untouched.
              </p>
            </div>
            <button
              type="button"
              onClick={prefill}
              disabled={prefilling}
              className="btn btn-primary whitespace-nowrap"
            >
              {prefilling ? "Looking through your data..." : "Prefill from my data"}
            </button>
          </div>

          {prefilled.length > 0 && (
            <div className="well mt-5">
              <p className="eyebrow mb-3">Filled in for you</p>
              <ul className="text-sm text-gray-700 space-y-1.5">
                {prefilled.map((f: any) => (
                  <li key={f.field}>
                    <strong className="text-gray-900">{f.label}:</strong>{" "}
                    {f.display}{" "}
                    <span className="text-gray-500">— {f.origin}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* What we already know */}
        {snapshot && (
          <div className="card card-pad mb-6">
            <h2 className="section-title mb-3">
              What we&apos;ve worked out from your data
            </h2>
            <p className="meta">
              Profile completeness · {snapshot.readiness}%
            </p>
            <div className="mt-2 mb-5 h-1 rounded-full bg-gray-100 overflow-hidden">
              <span
                className="block h-full rounded-full bg-indigo-500"
                style={{ width: `${snapshot.readiness}%` }}
              />
            </div>

            {eq && (
              <div className="mb-5">
                <p className="eyebrow mb-2">Equipment detected</p>
                <ul className="text-sm text-gray-600 list-disc ml-5 space-y-1">
                  {eq.evidence?.map((e: string, i: number) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </div>
            )}

            {snapshot.recommendedTests?.length > 0 && (
              <div className="alert alert-warn">
                <p className="font-semibold mb-2">
                  Tests we&apos;ll add to your plan to fill the gaps
                </p>
                <ul className="space-y-2">
                  {snapshot.recommendedTests.map((t: any) => (
                    <li key={t.key}>
                      <strong>{t.name}</strong> — {t.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* Body */}
        <section className="card card-pad mb-6">
          <h2 className="section-title mb-4">About you</h2>
          <div className="grid md:grid-cols-3 gap-4">
            <Field label="Age">
              <input type="number" className={input} value={p.age ?? ""} onChange={(e) => set("age", numOrNull(e.target.value))} />
            </Field>
            <Field label="Sex">
              <select className={input} value={p.gender ?? ""} onChange={(e) => set("gender", e.target.value)}>
                <option value="">Select...</option>
                <option>Female</option>
                <option>Male</option>
                <option>Other</option>
              </select>
            </Field>
            <Field label="Height (cm)">
              <input type="number" className={input} value={p.heightCm ?? ""} onChange={(e) => set("heightCm", numOrNull(e.target.value))} />
            </Field>
            <Field label="Weight (kg)" hint="Needed for power-to-weight and fuelling">
              <input type="number" step="0.1" className={input} value={p.weightKg ?? ""} onChange={(e) => set("weightKg", numOrNull(e.target.value))} />
            </Field>
            <Field label="Body fat (%)" hint="Optional">
              <input type="number" step="0.1" className={input} value={p.bodyFatPct ?? ""} onChange={(e) => set("bodyFatPct", numOrNull(e.target.value))} />
            </Field>
            <Field label="Time for training" hint="Set your day-by-day availability">
              <Link href="/availability" className="btn btn-secondary btn-sm">
                Set my weekly availability →
              </Link>
            </Field>
          </div>
        </section>

        {/* Physiology */}
        <section className="card card-pad mb-6">
          <h2 className="section-title mb-4">Baseline physiology</h2>
          <div className="grid md:grid-cols-4 gap-4">
            <Field label="Max heart rate" hint={detected(m?.maxHeartRate, (v) => `${v} bpm`) ?? undefined}>
              <input type="number" className={input} value={p.maxHeartRate ?? ""} onChange={(e) => set("maxHeartRate", numOrNull(e.target.value))} />
            </Field>
            <Field label="Resting heart rate" hint="Measure on waking">
              <input type="number" className={input} value={p.restingHeartRate ?? ""} onChange={(e) => set("restingHeartRate", numOrNull(e.target.value))} />
            </Field>
            <Field label="HRV (ms)" hint="Optional, from your watch">
              <input type="number" className={input} value={p.hrv ?? ""} onChange={(e) => set("hrv", numOrNull(e.target.value))} />
            </Field>
            <Field label="Threshold HR (overall)" hint="Blank uses the sport-specific values below">
              <input type="number" className={input} value={p.thresholdHeartRate ?? ""} onChange={(e) => set("thresholdHeartRate", numOrNull(e.target.value))} />
            </Field>
          </div>
        </section>

        {/* Preferences */}
        <section className="card card-pad mb-6">
          <h2 className="section-title mb-4">Preferences</h2>
          <div className="grid md:grid-cols-2 gap-4">
            <Field label="Favourite discipline">
              <select className={input} value={p.favouriteSport ?? ""} onChange={(e) => set("favouriteSport", e.target.value)}>
                <option value="">Select...</option>
                <option>Swim</option><option>Bike</option><option>Run</option>
              </select>
            </Field>
            <Field label="Least favourite discipline" hint="We'll protect consistency here">
              <select className={input} value={p.leastFavouriteSport ?? ""} onChange={(e) => set("leastFavouriteSport", e.target.value)}>
                <option value="">Select...</option>
                <option>Swim</option><option>Bike</option><option>Run</option>
              </select>
            </Field>
          </div>
        </section>

        {/* Per-discipline difficulty — how much each sport costs the athlete */}
        <section className="card card-pad mb-6">
          <h2 className="section-title mb-4">
            How hard each sport feels
          </h2>
          <p className="text-sm text-gray-600 mb-4">
            1.0 = normal. Raise a sport if it costs you more than most people
            (e.g. running 1.3), lower it if it comes easily (e.g. swimming 0.8).
          </p>
          <div className="grid md:grid-cols-3 gap-4">
            {(
              [
                ["swimDifficulty", "Swim"],
                ["bikeDifficulty", "Bike"],
                ["runDifficulty", "Run"],
              ] as const
            ).map(([key, label]) => (
              <Field key={key} label={label}>
                <input
                  type="number"
                  step="0.1"
                  min="0.5"
                  max="2"
                  className={input}
                  value={p[key] ?? 1}
                  onChange={(e) =>
                    set(key, e.target.value ? parseFloat(e.target.value) : 1)
                  }
                />
              </Field>
            ))}
          </div>
        </section>

        {/* Health */}
        <section className="card card-pad mb-6">
          <h2 className="section-title mb-4">Health &amp; injuries</h2>
          <div className="space-y-4">
            <Field label="Past injuries" hint="e.g. 'Left achilles tendinopathy 2024, recovered'">
              <textarea rows={2} className="textarea" value={p.injuryHistory ?? ""} onChange={(e) => set("injuryHistory", e.target.value)} />
            </Field>
            <Field label="Anything currently bothering you?" hint="e.g. 'Right knee sore after long runs'">
              <textarea rows={2} className="textarea" value={p.ongoingIssues ?? ""} onChange={(e) => set("ongoingIssues", e.target.value)} />
            </Field>
            <div className="grid md:grid-cols-2 gap-4">
              <Field label="Chronic conditions" hint="e.g. asthma">
                <input className={input} value={p.chronicConditions ?? ""} onChange={(e) => set("chronicConditions", e.target.value)} />
              </Field>
              <Field label="Mobility limitations" hint="e.g. tight hips, limited ankle range">
                <input className={input} value={p.mobilityLimitations ?? ""} onChange={(e) => set("mobilityLimitations", e.target.value)} />
              </Field>
            </div>
            <div className="border-t pt-4">
              <label className="flex items-center gap-2 mb-3">
                <input type="checkbox" checked={Boolean(p.tracksMenstrualCycle)} onChange={(e) => set("tracksMenstrualCycle", e.target.checked)} />
                <span className="text-gray-800">Adapt my training to my menstrual cycle</span>
              </label>
              {p.tracksMenstrualCycle && (
                <div className="grid md:grid-cols-2 gap-4">
                  <Field label="Typical cycle length (days)">
                    <input type="number" className={input} value={p.cycleLengthDays ?? ""} onChange={(e) => set("cycleLengthDays", numOrNull(e.target.value))} />
                  </Field>
                  <Field label="First day of last period">
                    <input type="date" className={input} value={toDateInput(p.lastPeriodStart)} onChange={(e) => set("lastPeriodStart", e.target.value)} />
                  </Field>
                </div>
              )}
            </div>
          </div>
        </section>

        {/* Swim */}
        <section className="card card-pad mb-6">
          <h2 className="section-title mb-4">Swim</h2>
          <div className="grid md:grid-cols-3 gap-4">
            <Field label="CSS pace per 100m (mm:ss)" hint={detected(m?.swimCssSecPer100, (v) => `${Math.floor(v/60)}:${String(v%60).padStart(2,"0")}/100m`) ?? "From a 400m + 200m test"}>
              <input className={input} placeholder="1:45" value={fromSeconds(p.swimCssSecPer100)} onChange={(e) => set("swimCssSecPer100", toSeconds(e.target.value))} />
            </Field>
            <Field label="Strokes per length">
              <input type="number" className={input} value={p.swimStrokeCount ?? ""} onChange={(e) => set("swimStrokeCount", numOrNull(e.target.value))} />
            </Field>
            <Field label="Open water confidence">
              <select className={input} value={p.swimComfortOpenWater ?? ""} onChange={(e) => set("swimComfortOpenWater", e.target.value)}>
                <option value="">Select...</option>
                <option value="confident">Confident</option>
                <option value="okay">Okay</option>
                <option value="nervous">Nervous</option>
                <option value="no experience">No experience</option>
              </select>
            </Field>
          </div>
        </section>

        {/* Bike */}
        <section className="card card-pad mb-6">
          <h2 className="section-title mb-4">Bike</h2>
          <div className="grid md:grid-cols-3 gap-4">
            <Field label="FTP (watts)" hint={detected(m?.ftpWatts, (v) => `${v} W`) ?? undefined}>
              <input type="number" className={input} value={p.ftpWatts ?? ""} onChange={(e) => set("ftpWatts", numOrNull(e.target.value))} />
            </Field>
            <Field label="Threshold HR on bike" hint={detected(m?.bikeLthr, (v) => `${v} bpm`) ?? undefined}>
              <input type="number" className={input} value={p.bikeLthr ?? ""} onChange={(e) => set("bikeLthr", numOrNull(e.target.value))} />
            </Field>
            <Field label="Average cadence (rpm)">
              <input type="number" className={input} value={p.bikeAvgCadence ?? ""} onChange={(e) => set("bikeAvgCadence", numOrNull(e.target.value))} />
            </Field>
          </div>
        </section>

        {/* Run */}
        <section className="card card-pad mb-6">
          <h2 className="section-title mb-4">Run</h2>
          <div className="grid md:grid-cols-3 gap-4">
            <Field label="Threshold pace per km (mm:ss)" hint={detected(m?.runThresholdPaceSec, (v) => `${Math.floor(v/60)}:${String(v%60).padStart(2,"0")}/km`) ?? undefined}>
              <input className={input} placeholder="4:30" value={fromSeconds(p.runThresholdPaceSec)} onChange={(e) => set("runThresholdPaceSec", toSeconds(e.target.value))} />
            </Field>
            <Field label="Threshold HR on run" hint={detected(m?.runLthr, (v) => `${v} bpm`) ?? undefined}>
              <input type="number" className={input} value={p.runLthr ?? ""} onChange={(e) => set("runLthr", numOrNull(e.target.value))} />
            </Field>
            <Field label="Cadence (spm)">
              <input type="number" className={input} value={p.runCadence ?? ""} onChange={(e) => set("runCadence", numOrNull(e.target.value))} />
            </Field>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 mt-6 mb-2">
            <p className="font-semibold text-gray-800">Personal bests</p>
            <button
              type="button"
              onClick={syncPbs}
              disabled={syncingPbs}
              className="btn btn-primary btn-sm"
            >
              {syncingPbs ? "Reading your Strava runs..." : "Pull my PBs from Strava"}
            </button>
          </div>
          {snapshot?.personalBests?.length > 0 && (
            <div className="bg-gray-50 rounded p-3 mb-3 text-sm text-gray-700">
              <p className="font-semibold mb-1">Found in your Strava history:</p>
              <ul className="list-disc ml-5">
                {snapshot.personalBests.map((p: any) => (
                  <li key={p.key}>
                    {p.label}: <strong>{p.time}</strong> — {p.date} ({p.activityName}){" "}
                    {p.precision === "official" ? "· official Strava split" : "· whole-run time"}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="grid md:grid-cols-4 gap-4">
            {([["pb5kSec","5 km"],["pb10kSec","10 km"],["pbHalfSec","Half marathon"],["pbMarathonSec","Marathon"]] as const).map(([k,label]) => (
              <Field key={k} label={label}>
                <input className={input} placeholder="mm:ss" value={fromSeconds(p[k])} onChange={(e) => set(k, toSeconds(e.target.value))} />
              </Field>
            ))}
          </div>
        </section>

        <div className="flex gap-3 mb-10">
          <button onClick={save} disabled={saving} className="btn btn-primary btn-lg">
            {saving ? "Saving..." : "Save athlete profile"}
          </button>
        </div>

        {/* What the coach believes about the body, and how much it trusts it. */}
        <div className="card card-pad mb-6">
          <FitnessPanel />
        </div>

        <div className="flex gap-3 flex-wrap">
          <Link href="/race" className="btn btn-secondary btn-lg">
            Next: race details →
          </Link>
        </div>
      </div>
    </div>
  );
}

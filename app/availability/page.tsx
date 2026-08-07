"use client";

import { useEffect, useState, useCallback } from "react";
import { useAuth } from "@/lib/auth-context";
import Link from "next/link";

const DAYS = [
  ["monHours", "Monday"],
  ["tueHours", "Tuesday"],
  ["wedHours", "Wednesday"],
  ["thuHours", "Thursday"],
  ["friHours", "Friday"],
  ["satHours", "Saturday"],
  ["sunHours", "Sunday"],
] as const;

const input = "input";

export default function AvailabilityPage() {
  const { user, isLoading: authLoading } = useAuth();
  const [form, setForm] = useState<any>({
    monHours: 0, tueHours: 0, wedHours: 0, thuHours: 0,
    friHours: 0, satHours: 0, sunHours: 0,
    poolAccess: true, gymAccess: true, indoorTrainer: false,
    noTimeConstraints: false,
  });
  const [budget, setBudget] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const data = await fetch(`/api/availability?userId=${user.id}`).then((r) =>
        r.json()
      );
      setBudget(data);
      const a = data.availability;
      if (a) {
        const next: any = { ...form };
        a.byDay.forEach((d: any, i: number) => {
          next[DAYS[i][0]] = d.hours;
        });
        next.longSessionDay = a.longSessionDay ?? "";
        next.constraints = a.constraints ?? "";
        next.noTimeConstraints = a.noTimeConstraints;
        next.poolAccess = a.poolAccess;
        next.gymAccess = a.gymAccess;
        next.indoorTrainer = a.indoorTrainer;
        setForm(next);
      }
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  useEffect(() => {
    if (authLoading || !user) return;
    load();
  }, [user, authLoading, load]);

  const total = DAYS.reduce((s, [k]) => s + (Number(form[k]) || 0), 0);

  async function save() {
    if (!user) return;
    setSaving(true);
    setMessage("");
    try {
      const res = await fetch("/api/availability", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, ...form }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Save failed");
      setBudget(data);
      setMessage("Saved. Your next plan will fit inside this.");
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
        <p className="text-gray-600">Loading...</p>
      </div>
    );
  }

  const cap = budget?.capacity;

  return (
    <div className="page-shell">
      <div className="page-inner-narrow">
        <header className="mb-8 sm:mb-10">
          <p className="eyebrow mb-3">Me / Availability</p>
          <h1 className="page-title">
            Your time for training
          </h1>
          <p className="page-subtitle">
            How much time you <em>have</em> — not how much you currently train.
          </p>
        </header>

        {message && (
          <div className="alert alert-success mb-6">{message}</div>
        )}

        <section className="card card-pad mb-6">
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              className="mt-1"
              checked={Boolean(form.noTimeConstraints)}
              onChange={(e) =>
                setForm({ ...form, noTimeConstraints: e.target.checked })
              }
            />
            <span>
              <span className="font-semibold text-gray-800">
                I have no real time constraints
              </span>
              <span className="block text-sm text-gray-600">
                Train whenever needed. Your plan will then be limited only by
                what your body can absorb — it still won&apos;t jump your volume
                just because the time is there.
              </span>
            </span>
          </label>
        </section>

        <section className={`card card-pad mb-6 ${
            form.noTimeConstraints ? "opacity-50 pointer-events-none" : ""
          }`}>
          <h2 className="section-title mb-1">
            Hours available each day
          </h2>
          <p className="text-sm text-gray-600 mb-4">
            Put 0 for days you can&apos;t train. Sessions will never be longer
            than the time you have on that day.
          </p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {DAYS.map(([key, label]) => (
              <div key={key}>
                <label className="label">
                  {label}
                </label>
                <input
                  type="number"
                  step="0.25"
                  min="0"
                  max="12"
                  className={input}
                  value={form[key] ?? 0}
                  onChange={(e) =>
                    setForm({ ...form, [key]: parseFloat(e.target.value) || 0 })
                  }
                />
              </div>
            ))}
            <div className="flex flex-col justify-end">
              <p className="meta">Total</p>
              <p className="numeral">
                {Math.round(total * 10) / 10} h
              </p>
            </div>
          </div>
        </section>

        <section className="card card-pad mb-6">
          <h2 className="section-title mb-4">
            Practical constraints
          </h2>
          <div className="grid md:grid-cols-2 gap-4 mb-4">
            <div>
              <label className="label">
                Best day for your long session
              </label>
              <select
                className={input}
                value={form.longSessionDay ?? ""}
                onChange={(e) => setForm({ ...form, longSessionDay: e.target.value })}
              >
                <option value="">No preference</option>
                {DAYS.map(([, label]) => (
                  <option key={label}>{label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">
                Anything else we should know?
              </label>
              <input
                className={input}
                placeholder="e.g. pool closed Sundays, kids' pickup at 6pm"
                value={form.constraints ?? ""}
                onChange={(e) => setForm({ ...form, constraints: e.target.value })}
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-6">
            {([
              ["poolAccess", "I can access a pool"],
              ["gymAccess", "I can access a gym"],
              ["indoorTrainer", "I have an indoor bike trainer"],
            ] as const).map(([key, label]) => (
              <label key={key} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={Boolean(form[key])}
                  onChange={(e) => setForm({ ...form, [key]: e.target.checked })}
                />
                <span className="text-gray-800">{label}</span>
              </label>
            ))}
          </div>
        </section>

        {/* Capacity — derived, read-only */}
        <section className="card card-pad mb-6">
          <h2 className="section-title mb-1">
            What your body is ready for
          </h2>
          <p className="text-sm text-gray-600 mb-4">
            Worked out from your training history — this is different from how
            much time you have.
          </p>
          {cap?.hasData ? (
            <div className="flex flex-wrap gap-8">
              <div>
                <p className="meta">Recently training</p>
                <p className="numeral">
                  {cap.recentWeeklyHours} h/week
                </p>
              </div>
              <div>
                <p className="meta">Biggest recent week</p>
                <p className="numeral">
                  {cap.peakWeeklyHours} h
                </p>
              </div>
              <div>
                <p className="meta">Safe to build to next</p>
                <p className="numeral">
                  {cap.safeNextWeekHours} h
                </p>
              </div>
            </div>
          ) : null}

          {/* Where the number comes from. A figure with no working shown is
              one the athlete can neither trust nor argue with — and this one
              decides how hard their plan is. */}
          {cap?.hasData ? (
            <div className="well mt-6">
              <p className="text-gray-700 text-sm">{cap.basis}</p>
              <p className="text-gray-600 text-sm mt-2">
                &ldquo;Safe to build to&rdquo; is your recent average, or 80% of
                your biggest week if that is higher, plus 10%. It is a ceiling on
                how fast to grow, not a verdict on what you are capable of — a
                month off drags the average down long before your fitness
                follows.
              </p>
              <p className="text-gray-600 text-sm mt-2">
                If this looks low to you, it probably is, and the coach would
                rather ask than guess: check{" "}
                <Link href="/today" className="text-indigo-700 underline">
                  Today
                </Link>{" "}
                — if there is a judgement call open about how hard to rebuild,
                answering it changes this figure and your plan with it.
              </p>
            </div>
          ) : (
            <p className="text-gray-600">
              Not enough training history yet to judge this.
            </p>
          )}
        </section>

        {/* The resulting decision */}
        {budget && (
          <section
            className={`card card-pad mb-6 ${
              budget.bindingConstraint === "unknown"
                ? "card-flag"
                : "card-signal"
            }`}
          >
            <h2 className="section-title mb-2">
              What your plan will target
            </h2>
            {budget.recommendedWeeklyHours ? (
              <p className="numeral mb-2">
                {budget.recommendedWeeklyHours} h/week
                <span className="text-base font-normal text-gray-600">
                  {" "}
                  — limited by{" "}
                  {budget.bindingConstraint === "time"
                    ? "your available time"
                    : "your current fitness"}
                </span>
              </p>
            ) : null}
            <p className="text-gray-700">{budget.explanation}</p>
          </section>
        )}

        <button
          onClick={save}
          disabled={saving}
          className="btn btn-primary btn-lg mb-10"
        >
          {saving ? "Saving..." : "Save my availability"}
        </button>
      </div>
    </div>
  );
}

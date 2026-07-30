"use client";

import { useEffect, useState, useCallback } from "react";
import { useAuth } from "@/lib/auth-context";
import { useRouter } from "next/navigation";
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

const input =
  "w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500";

export default function AvailabilityPage() {
  const { user, isLoading: authLoading } = useAuth();
  const router = useRouter();
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
    if (authLoading) return;
    if (!user) {
      router.push("/login");
      return;
    }
    load();
  }, [user, authLoading, router, load]);

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
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 py-10 px-4">
      <div className="max-w-3xl mx-auto">
        <div className="flex justify-between items-center mb-6">
          <div>
            <h1 className="text-3xl font-bold text-indigo-900">
              Your time for training
            </h1>
            <p className="text-gray-600">
              How much time you <em>have</em> — not how much you currently train.
            </p>
          </div>
          <Link href="/athlete" className="bg-white text-indigo-700 border border-indigo-300 px-4 py-2 rounded-lg">
            Athlete
          </Link>
        </div>

        {message && (
          <div className="bg-green-100 text-green-900 px-4 py-3 rounded mb-6">
            {message}
          </div>
        )}

        <section className="bg-white rounded-lg shadow p-6 mb-6">
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

        <section
          className={`bg-white rounded-lg shadow p-6 mb-6 ${
            form.noTimeConstraints ? "opacity-50 pointer-events-none" : ""
          }`}
        >
          <h2 className="text-xl font-bold text-indigo-900 mb-1">
            Hours available each day
          </h2>
          <p className="text-sm text-gray-600 mb-4">
            Put 0 for days you can&apos;t train. Sessions will never be longer
            than the time you have on that day.
          </p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {DAYS.map(([key, label]) => (
              <div key={key}>
                <label className="block text-sm font-medium text-gray-700 mb-1">
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
              <p className="text-sm text-gray-500">Total</p>
              <p className="text-2xl font-bold text-indigo-900">
                {Math.round(total * 10) / 10} h
              </p>
            </div>
          </div>
        </section>

        <section className="bg-white rounded-lg shadow p-6 mb-6">
          <h2 className="text-xl font-bold text-indigo-900 mb-4">
            Practical constraints
          </h2>
          <div className="grid md:grid-cols-2 gap-4 mb-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
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
              <label className="block text-sm font-medium text-gray-700 mb-1">
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
        <section className="bg-white rounded-lg shadow p-6 mb-6">
          <h2 className="text-xl font-bold text-indigo-900 mb-1">
            What your body is ready for
          </h2>
          <p className="text-sm text-gray-600 mb-4">
            Worked out from your training history — this is different from how
            much time you have.
          </p>
          {cap?.hasData ? (
            <div className="flex flex-wrap gap-8">
              <div>
                <p className="text-sm text-gray-500">Recently training</p>
                <p className="text-2xl font-bold text-indigo-900">
                  {cap.recentWeeklyHours} h/week
                </p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Biggest recent week</p>
                <p className="text-2xl font-bold text-indigo-900">
                  {cap.peakWeeklyHours} h
                </p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Safe to build to next</p>
                <p className="text-2xl font-bold text-indigo-900">
                  {cap.safeNextWeekHours} h
                </p>
              </div>
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
            className={`rounded-lg p-6 mb-6 border ${
              budget.bindingConstraint === "unknown"
                ? "bg-amber-50 border-amber-300"
                : "bg-indigo-50 border-indigo-200"
            }`}
          >
            <h2 className="text-lg font-bold text-indigo-900 mb-2">
              What your plan will target
            </h2>
            {budget.recommendedWeeklyHours ? (
              <p className="text-2xl font-bold text-indigo-900 mb-2">
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
          className="bg-indigo-600 text-white px-8 py-3 rounded-lg font-semibold disabled:opacity-50 mb-10"
        >
          {saving ? "Saving..." : "Save my availability"}
        </button>
      </div>
    </div>
  );
}

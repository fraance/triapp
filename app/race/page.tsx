"use client";

import { useEffect, useState, useCallback } from "react";
import { useAuth } from "@/lib/auth-context";

const input =
  "w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      {children}
      {hint && <p className="text-xs text-gray-500 mt-1">{hint}</p>}
    </div>
  );
}

export default function RacePage() {
  const { user, isLoading: authLoading } = useAuth();
  const [r, setR] = useState<any>({});
  const [loading, setLoading] = useState(true);
  const [researching, setResearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [questions, setQuestions] = useState<string[]>([]);
  const [unknown, setUnknown] = useState<string[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [usedWeb, setUsedWeb] = useState(false);
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const data = await fetch(`/api/race-profile?userId=${user.id}`).then((res) => res.json());
      setR(data || {});
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (authLoading || !user) return;
    load();
  }, [user, authLoading, load]);

  const set = (k: string, v: any) => setR((prev: any) => ({ ...prev, [k]: v }));
  const numOrNull = (v: string) => (v === "" ? null : parseFloat(v));

  async function research() {
    if (!user) return;
    setResearching(true);
    setMessage("");
    setQuestions([]);
    try {
      const res = await fetch("/api/race-profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: user.id,
          raceName: r.raceName,
          location: r.location,
          raceDate: r.raceDate,
          distanceType: r.distanceType,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Lookup failed");
      setR({ ...data.race, raceDate: data.race.raceDate?.split("T")[0] });
      setQuestions(data.questionsForAthlete || []);
      setUnknown(data.unknownFields || []);
      setSources(data.sources || []);
      setUsedWeb(Boolean(data.usedWebSearch));
      setNotFound(data.raceIdentified === false);
      setMessage(
        data.raceIdentified === false
          ? "We couldn't find reliable information for this specific race, so we've left the fields blank rather than guess. Please fill in whatever you know below — anything you leave empty simply won't be used."
          : `${data.usedWebSearch ? "Searched the web" : "Used the model's own knowledge"} — confidence: ${data.aiConfidence}. Please check every value below and correct anything wrong, then confirm.`
      );
    } catch (e: any) {
      setMessage(e.message || "Lookup failed");
    } finally {
      setResearching(false);
    }
  }

  async function save(confirmed: boolean) {
    if (!user) return;
    setSaving(true);
    setMessage("");
    try {
      const res = await fetch("/api/race-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, ...r, confirmed }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Save failed");
      setR({ ...data, raceDate: data.raceDate?.split("T")[0] });
      setMessage(confirmed ? "Race details confirmed. Your plan will target these demands." : "Saved.");
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
        <p className="text-gray-600">Loading race details...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 py-10 px-4">
      <div className="max-w-3xl mx-auto">
        <div className="mb-6">
          <h1 className="text-3xl font-bold text-indigo-900">Your race</h1>
          <p className="text-gray-600">
            The course decides the training. Tell us the race and we&apos;ll try
            to look up its demands.
          </p>
        </div>

        {message && <div className="bg-blue-100 text-blue-900 px-4 py-3 rounded mb-6">{message}</div>}

        {notFound && (
          <div className="bg-gray-100 border border-gray-300 text-gray-800 px-4 py-3 rounded mb-6">
            <strong>Race not found automatically.</strong> That&apos;s fine — smaller
            races often aren&apos;t documented online. Fill in whatever you know in
            the boxes below and leave the rest blank. Your plan will use only what
            you provide.
          </div>
        )}

        {sources.length > 0 && !notFound && (
          <section className="bg-white rounded-lg shadow p-6 mb-6">
            <h2 className="text-lg font-bold text-indigo-900 mb-2">
              {usedWeb ? "Sources found on the web" : "Sources"}
            </h2>
            <ul className="list-disc ml-5 text-sm space-y-1">
              {sources.map((u, i) => (
                <li key={i}>
                  <a href={u} target="_blank" rel="noreferrer" className="text-indigo-600 underline break-all">
                    {u}
                  </a>
                </li>
              ))}
            </ul>
            <p className="text-xs text-gray-500 mt-2">
              Open these to verify the figures before confirming.
            </p>
          </section>
        )}

        {(r.source === "ai_suggested" || r.source === "web_research") && !r.confirmed && (
          <div className="bg-amber-50 border border-amber-300 text-amber-900 px-4 py-3 rounded mb-6">
            ⚠️ These values were suggested automatically and have <strong>not been
            confirmed</strong>. They may be wrong. Please check them before your
            plan relies on them.
          </div>
        )}

        <section className="bg-white rounded-lg shadow p-6 mb-6">
          <h2 className="text-xl font-bold text-indigo-900 mb-4">Which race?</h2>
          <div className="grid md:grid-cols-2 gap-4 mb-4">
            <Field label="Race name" hint="e.g. Ironman 70.3 Nice">
              <input className={input} value={r.raceName ?? ""} onChange={(e) => set("raceName", e.target.value)} />
            </Field>
            <Field label="Location">
              <input className={input} value={r.location ?? ""} onChange={(e) => set("location", e.target.value)} />
            </Field>
            <Field label="Race date">
              <input type="date" className={input} value={r.raceDate ?? ""} onChange={(e) => set("raceDate", e.target.value)} />
            </Field>
            <Field label="Distance">
              <select className={input} value={r.distanceType ?? ""} onChange={(e) => set("distanceType", e.target.value)}>
                <option value="">Select...</option>
                <option>Sprint</option><option>Olympic</option><option>70.3</option><option>Full IM</option>
              </select>
            </Field>
          </div>
          <button onClick={research} disabled={researching} className="bg-indigo-600 text-white px-6 py-2 rounded-lg disabled:opacity-50">
            {researching ? "Looking up the course..." : "Look up this race for me"}
          </button>
          <p className="text-xs text-gray-500 mt-2">
            We&apos;ll fill in what we can and ask you about the rest. Always check
            the results — never assume they&apos;re right.
          </p>
        </section>

        {questions.length > 0 && (
          <section className="bg-white rounded-lg shadow p-6 mb-6 border-l-4 border-amber-400">
            <h2 className="text-xl font-bold text-indigo-900 mb-2">
              We couldn&apos;t work these out — can you help?
            </h2>
            {unknown.length > 0 && (
              <p className="text-sm text-gray-600 mb-3">Missing: {unknown.join(", ")}</p>
            )}
            <ul className="list-disc ml-5 text-gray-700 space-y-1">
              {questions.map((q, i) => <li key={i}>{q}</li>)}
            </ul>
          </section>
        )}

        <section className="bg-white rounded-lg shadow p-6 mb-6">
          <h2 className="text-xl font-bold text-indigo-900 mb-4">Swim</h2>
          <div className="grid md:grid-cols-3 gap-4">
            <Field label="Environment">
              <select className={input} value={r.swimEnvironment ?? ""} onChange={(e) => set("swimEnvironment", e.target.value)}>
                <option value="">Select...</option>
                <option value="ocean">Ocean / sea</option>
                <option value="lake">Lake</option>
                <option value="river">River</option>
                <option value="pool">Pool</option>
              </select>
            </Field>
            <Field label="Water temperature (°C)">
              <input type="number" className={input} value={r.waterTempC ?? ""} onChange={(e) => set("waterTempC", numOrNull(e.target.value))} />
            </Field>
            <Field label="Wetsuit allowed?">
              <select className={input} value={r.wetsuitLikely === null || r.wetsuitLikely === undefined ? "" : String(r.wetsuitLikely)} onChange={(e) => set("wetsuitLikely", e.target.value === "" ? null : e.target.value === "true")}>
                <option value="">Not sure</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            </Field>
          </div>
        </section>

        <section className="bg-white rounded-lg shadow p-6 mb-6">
          <h2 className="text-xl font-bold text-indigo-900 mb-4">Bike course</h2>
          <div className="grid md:grid-cols-2 gap-4">
            <Field label="Profile">
              <select className={input} value={r.bikeCourseType ?? ""} onChange={(e) => set("bikeCourseType", e.target.value)}>
                <option value="">Select...</option>
                <option value="flat">Flat</option><option value="rolling">Rolling</option>
                <option value="hilly">Hilly</option><option value="mountainous">Mountainous</option>
              </select>
            </Field>
            <Field label="Total elevation gain (m)">
              <input type="number" className={input} value={r.bikeElevationGainM ?? ""} onChange={(e) => set("bikeElevationGainM", numOrNull(e.target.value))} />
            </Field>
          </div>
        </section>

        <section className="bg-white rounded-lg shadow p-6 mb-6">
          <h2 className="text-xl font-bold text-indigo-900 mb-4">Run course</h2>
          <div className="grid md:grid-cols-3 gap-4">
            <Field label="Profile">
              <select className={input} value={r.runCourseType ?? ""} onChange={(e) => set("runCourseType", e.target.value)}>
                <option value="">Select...</option>
                <option value="flat">Flat</option><option value="rolling">Rolling</option>
                <option value="hilly">Hilly</option><option value="mountainous">Mountainous</option>
              </select>
            </Field>
            <Field label="Elevation gain (m)">
              <input type="number" className={input} value={r.runElevationGainM ?? ""} onChange={(e) => set("runElevationGainM", numOrNull(e.target.value))} />
            </Field>
            <Field label="Surface">
              <select className={input} value={r.runSurface ?? ""} onChange={(e) => set("runSurface", e.target.value)}>
                <option value="">Select...</option>
                <option value="road">Road</option><option value="trail">Trail</option><option value="mixed">Mixed</option>
              </select>
            </Field>
          </div>
        </section>

        <section className="bg-white rounded-lg shadow p-6 mb-6">
          <h2 className="text-xl font-bold text-indigo-900 mb-4">Expected conditions</h2>
          <div className="grid md:grid-cols-3 gap-4">
            <Field label="Temperature (°C)">
              <input type="number" className={input} value={r.expectedTempC ?? ""} onChange={(e) => set("expectedTempC", numOrNull(e.target.value))} />
            </Field>
            <Field label="Humidity (%)">
              <input type="number" className={input} value={r.expectedHumidity ?? ""} onChange={(e) => set("expectedHumidity", numOrNull(e.target.value))} />
            </Field>
            <Field label="Wind">
              <input className={input} value={r.windNotes ?? ""} onChange={(e) => set("windNotes", e.target.value)} />
            </Field>
          </div>
        </section>

        <div className="flex gap-3 mb-10">
          <button onClick={() => save(true)} disabled={saving} className="bg-green-600 text-white px-8 py-3 rounded-lg font-semibold disabled:opacity-50">
            {saving ? "Saving..." : "Confirm race details"}
          </button>
          <button onClick={() => save(false)} disabled={saving} className="bg-white text-indigo-700 border border-indigo-300 px-6 py-3 rounded-lg">
            Save without confirming
          </button>
        </div>
      </div>
    </div>
  );
}

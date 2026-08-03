"use client";

import { useEffect, useState } from "react";
import { toDateInput } from "@/lib/date-input";
import Link from "next/link";
import { useAuth } from "@/lib/auth-context";
import { GarminConnect } from "@/components/GarminConnect";
import { GoogleCalendarConnect } from "@/components/GoogleCalendarConnect";

interface Profile {
  age?: number;
  gender?: string;
  raceDate?: string;
  raceType?: string;
  pastPerformance?: string;
  timezone?: string;
  maxHeartRate?: number;
  thresholdHeartRate?: number;
  ftpWatts?: number;
  swimDifficulty?: number;
  bikeDifficulty?: number;
  runDifficulty?: number;
}

export default function ProfilePage() {
  const { user } = useAuth();
  const [profile, setProfile] = useState<Profile>({});
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [detailWeeks, setDetailWeeks] = useState("4");
  // Only whether a plan exists, not its contents. The plan itself is shown on
  // the Plan tab; this page just needs to know whether to offer a link to it.
  const [hasPlan, setHasPlan] = useState(false);

  useEffect(() => {
    if (!user) return;

    // Load profile from the database
    fetch(`/api/profile?userId=${user.id}`)
      .then((res) => (res.ok ? res.json() : {}))
      .then((data: any) => {
        if (data && !data.error) setProfile(data);
      })
      .catch((err) => console.error("Error loading profile:", err));

    // Does a plan exist? Its contents live on the Plan tab.
    fetch(`/api/plans/latest?userId=${user.id}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: any) => {
        setHasPlan(Array.isArray(data) && data.length > 0);
      })
      .catch((err) => console.error("Error loading plan:", err));
  }, [user]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setIsSaving(true);
    setMessage("");

    try {
      if (user) {
        const res = await fetch("/api/profile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: user.id, ...profile }),
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || "Failed to save profile");
        }
        setMessage("Profile saved successfully!");
        setTimeout(() => setMessage(""), 3000);
      }
    } catch (error: any) {
      setMessage(error.message || "An error occurred");
      console.error("Error saving profile:", error);
    } finally {
      setIsSaving(false);
    }
  }

  async function handleGeneratePlan() {
    if (!profile.raceDate) {
      setMessage("Please set a race date in your profile first");
      return;
    }

    setIsGenerating(true);
    setMessage("");

    try {
      const res = await fetch("/api/generate-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user?.id, detailWeeks, ...profile }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Failed to generate plan");
      }

      setHasPlan(true);
      setMessage(
        `Plan generated! ${data.totalWeeks} weeks to race day, first ${data.detailWeeks} weeks detailed.` +
          (data.usedStravaHistory ? " Based on your Strava history." : "") +
          (data.usedDocuments ? " Used your uploaded files." : "")
      );
      setTimeout(() => setMessage(""), 8000);
    } catch (error: any) {
      setMessage(error.message || "Failed to generate plan");
      console.error("Error:", error);
    } finally {
      setIsGenerating(false);
    }
  }

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-xl text-gray-600">Loading...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 py-12 px-4">
      <div className="max-w-4xl mx-auto">
        <div className="mb-6">
          <h1 className="text-3xl font-bold text-indigo-900">
            Account &amp; plan
          </h1>
          <p className="text-gray-600">
            Signed in as <strong>{user.email}</strong>
          </p>
        </div>



        {/* Profile Form */}
        <div className="bg-white rounded-lg shadow-lg p-8 mb-8">
          <h2 className="text-2xl font-bold text-indigo-900 mb-6">Your Profile</h2>

          <form onSubmit={handleSave} className="space-y-6">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Age
              </label>
              <input
                type="number"
                value={profile.age || ""}
                onChange={(e) =>
                  setProfile({ ...profile, age: e.target.value ? parseInt(e.target.value) : undefined })
                }
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                placeholder="e.g., 35"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Gender
              </label>
              <select
                value={profile.gender || ""}
                onChange={(e) =>
                  setProfile({ ...profile, gender: e.target.value || undefined })
                }
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="">Select...</option>
                <option value="Male">Male</option>
                <option value="Female">Female</option>
                <option value="Other">Other</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Race Date
              </label>
              <input
                type="date"
                value={toDateInput(profile.raceDate)}
                onChange={(e) =>
                  setProfile({ ...profile, raceDate: e.target.value || undefined })
                }
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Race Type
              </label>
              <select
                value={profile.raceType || ""}
                onChange={(e) =>
                  setProfile({ ...profile, raceType: e.target.value || undefined })
                }
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="">Select...</option>
                <option value="Sprint">Sprint</option>
                <option value="Olympic">Olympic</option>
                <option value="70.3">70.3</option>
                <option value="Full IM">Full IM</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Past Performance & Notes
            </label>
            <textarea
              value={profile.pastPerformance || ""}
              onChange={(e) =>
                setProfile({ ...profile, pastPerformance: e.target.value || undefined })
              }
              rows={4}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder="Share your past race results, injuries, or other relevant context..."
            />
          </div>


          {/* Thresholds — these drive how training load is calculated */}
          <div className="border-t pt-6">
            <h3 className="text-lg font-bold text-indigo-900 mb-1">
              Your physiology
            </h3>
            <p className="text-sm text-gray-600 mb-4">
              These make your training load (TSS) numbers accurate. Leave blank
              and we&apos;ll estimate from your Strava data.
            </p>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Max HR
                </label>
                <input
                  type="number"
                  value={profile.maxHeartRate ?? ""}
                  onChange={(e) =>
                    setProfile({
                      ...profile,
                      maxHeartRate: e.target.value ? parseInt(e.target.value) : undefined,
                    })
                  }
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg"
                  placeholder="e.g., 190"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Threshold HR
                </label>
                <input
                  type="number"
                  value={profile.thresholdHeartRate ?? ""}
                  onChange={(e) =>
                    setProfile({
                      ...profile,
                      thresholdHeartRate: e.target.value
                        ? parseInt(e.target.value)
                        : undefined,
                    })
                  }
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg"
                  placeholder="e.g., 172"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  FTP (watts)
                </label>
                <input
                  type="number"
                  value={profile.ftpWatts ?? ""}
                  onChange={(e) =>
                    setProfile({
                      ...profile,
                      ftpWatts: e.target.value ? parseInt(e.target.value) : undefined,
                    })
                  }
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg"
                  placeholder="e.g., 240"
                />
              </div>
            </div>
          </div>

          {/* Per-discipline difficulty */}
          <div className="border-t pt-6">
            <h3 className="text-lg font-bold text-indigo-900 mb-1">
              How hard each sport feels for you
            </h3>
            <p className="text-sm text-gray-600 mb-4">
              1.0 = normal. Raise a sport if it costs you more than most people
              (e.g. running 1.3), lower it if it comes easily (e.g. swimming 0.8).
            </p>
            <div className="grid grid-cols-3 gap-4">
              {(
                [
                  ["swimDifficulty", "Swim"],
                  ["bikeDifficulty", "Bike"],
                  ["runDifficulty", "Run"],
                ] as const
              ).map(([key, label]) => (
                <div key={key}>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {label}
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    min="0.5"
                    max="2"
                    value={profile[key] ?? 1}
                    onChange={(e) =>
                      setProfile({
                        ...profile,
                        [key]: e.target.value ? parseFloat(e.target.value) : 1,
                      })
                    }
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg"
                  />
                </div>
              ))}
            </div>
          </div>

          {message && (
            <div
              className={`px-4 py-3 rounded ${
                message.includes("successfully")
                  ? "bg-green-100 text-green-700"
                  : "bg-red-100 text-red-700"
              }`}
            >
              {message}
            </div>
          )}

          <button
            type="submit"
            disabled={isSaving}
            className="w-full bg-indigo-600 text-white font-semibold py-2 rounded-lg hover:bg-indigo-700 transition disabled:opacity-50"
          >
            {isSaving ? "Saving..." : "Save Profile"}
          </button>
        </form>
        </div>

        {/* Generate Plan Section */}
        <div className="bg-white rounded-lg shadow-lg p-8 mb-8">
          <h2 className="text-2xl font-bold text-indigo-900 mb-4">
            Generate Your Training Plan
          </h2>
          <p className="text-gray-600 mb-6">
            {profile.raceDate
              ? `Training for ${profile.raceType || "your"} race on ${new Date(profile.raceDate).toDateString()}`
              : "Set your race date above to generate a plan"}
          </p>

          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              How many weeks of detailed sessions to write now?
            </label>
            <select
              value={detailWeeks}
              onChange={(e) => setDetailWeeks(e.target.value)}
              className="px-4 py-2 border border-gray-300 rounded-lg"
            >
              <option value="4">Next 4 weeks (fastest)</option>
              <option value="8">Next 8 weeks</option>
              <option value="12">Next 12 weeks</option>
              <option value="all">All weeks to race day (slowest)</option>
            </select>
            <p className="text-sm text-gray-500 mt-1">
              Every week to race day always gets a phase and targets. This only
              controls how far ahead the day-by-day workouts are written. You can
              add more later from the Season page.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={handleGeneratePlan}
              disabled={isGenerating || !profile.raceDate}
              className="bg-indigo-600 text-white px-8 py-3 rounded-lg hover:bg-indigo-700 transition disabled:opacity-50 font-semibold"
            >
              {isGenerating ? "Generating Plan..." : "Generate AI Training Plan"}
            </button>
            {hasPlan && (
              <Link
                href="/season"
                className="text-indigo-700 border border-indigo-300 px-6 py-3 rounded-lg"
              >
                View my plan →
              </Link>
            )}
          </div>
        </div>

        {/* Strava Integration Section */}
        <div className="bg-white rounded-lg shadow-lg p-8 mb-8">
          <h2 className="text-2xl font-bold text-indigo-900 mb-4">
            Strava Integration
          </h2>
          <p className="text-gray-600 mb-6">
            Import your real training history from Strava so your AI plan is
            based on what you actually do.
          </p>
          <a
            href="/strava"
            className="inline-block bg-orange-600 text-white px-6 py-2 rounded-lg hover:bg-orange-700 transition"
          >
            Manage Strava
          </a>
        </div>

        {/* Garmin Integration Section */}
        <div className="bg-white rounded-lg shadow-lg p-8 mb-8">
          <h2 className="text-2xl font-bold text-indigo-900 mb-4">
            Garmin Integration
          </h2>
          <p className="text-gray-600 mb-6">
            Once approved, Garmin will auto-sync completed workouts and daily
            health metrics.
          </p>
          <GarminConnect />
        </div>

        {/* Google Calendar Integration Section */}
        <div className="bg-white rounded-lg shadow-lg p-8 mb-8">
          <h2 className="text-2xl font-bold text-indigo-900 mb-4">
            Google Calendar Integration
          </h2>
          <p className="text-gray-600 mb-6">
            Planned: read travel and life events, and write sessions to your
            calendar.
          </p>
          <GoogleCalendarConnect />
        </div>

      </div>
    </div>
  );
}

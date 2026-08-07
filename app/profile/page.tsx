"use client";

import { useEffect, useState } from "react";
import { toDateInput } from "@/lib/date-input";
import Link from "next/link";
import { useAuth } from "@/lib/auth-context";
import { GarminConnect } from "@/components/GarminConnect";
import { GoogleCalendarConnect } from "@/components/GoogleCalendarConnect";

interface Profile {
  raceDate?: string;
  raceType?: string;
  pastPerformance?: string;
  timezone?: string;
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
    <div className="page-shell">
      <div className="page-inner">
        <header className="mb-8 sm:mb-10">
          <p className="eyebrow mb-3">Settings / Account</p>
          <h1 className="page-title">
            Account &amp; plan
          </h1>
          <p className="page-subtitle">
            Signed in as <strong>{user.email}</strong>
          </p>
        </header>



        {/* Profile Form */}
        <div className="card card-pad mb-8">
          <h2 className="section-title mb-6">Your Profile</h2>

          <form onSubmit={handleSave} className="space-y-6">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">
                Race Date
              </label>
              <input
                type="date"
                value={toDateInput(profile.raceDate)}
                onChange={(e) =>
                  setProfile({ ...profile, raceDate: e.target.value || undefined })
                }
                className="input"
              />
            </div>

            <div>
              <label className="label">
                Race Type
              </label>
              <select
                value={profile.raceType || ""}
                onChange={(e) =>
                  setProfile({ ...profile, raceType: e.target.value || undefined })
                }
                className="input"
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
            <label className="label">
              Past Performance & Notes
            </label>
            <textarea
              value={profile.pastPerformance || ""}
              onChange={(e) =>
                setProfile({ ...profile, pastPerformance: e.target.value || undefined })
              }
              rows={4}
              className="textarea"
              placeholder="Share your past race results, injuries, or other relevant context..."
            />
          </div>

          {message && (
            <div
              className={
                message.includes("successfully")
                  ? "alert alert-success"
                  : "alert alert-danger"
              }
            >
              {message}
            </div>
          )}

          <button
            type="submit"
            disabled={isSaving}
            className="btn btn-primary w-full btn-lg"
          >
            {isSaving ? "Saving..." : "Save Profile"}
          </button>
        </form>
        </div>

        {/* Generate Plan Section */}
        <div className="card card-pad mb-8">
          <h2 className="section-title mb-4">
            Generate Your Training Plan
          </h2>
          <p className="text-gray-600 mb-6">
            {profile.raceDate
              ? `Training for ${profile.raceType || "your"} race on ${new Date(profile.raceDate).toDateString()}`
              : "Set your race date above to generate a plan"}
          </p>

          <div className="mb-4">
            <label className="label">
              How many weeks of detailed sessions to write now?
            </label>
            <select
              value={detailWeeks}
              onChange={(e) => setDetailWeeks(e.target.value)}
              className="select"
            >
              <option value="4">Next 4 weeks (fastest)</option>
              <option value="8">Next 8 weeks</option>
              <option value="12">Next 12 weeks</option>
              <option value="all">All weeks to race day (slowest)</option>
            </select>
            <p className="hint">
              Every week to race day always gets a phase and targets. This only
              controls how far ahead the day-by-day workouts are written. You can
              add more later from the Season page.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={handleGeneratePlan}
              disabled={isGenerating || !profile.raceDate}
              className="btn btn-primary btn-lg"
            >
              {isGenerating ? "Generating Plan..." : "Generate AI Training Plan"}
            </button>
            {hasPlan && (
              <Link
                href="/season"
                className="btn btn-secondary btn-lg"
              >
                View my plan →
              </Link>
            )}
          </div>
        </div>

        {/* Strava Integration Section */}
        <div className="card card-pad mb-8">
          <h2 className="section-title mb-4">
            Strava Integration
          </h2>
          <p className="text-gray-600 mb-6">
            Import your real training history from Strava so your AI plan is
            based on what you actually do.
          </p>
          <a
            href="/strava"
            className="btn btn-primary"
          >
            Manage Strava
          </a>
        </div>

        {/* Garmin Integration Section */}
        <div className="card card-pad mb-8">
          <h2 className="section-title mb-4">
            Garmin Integration
          </h2>
          <p className="text-gray-600 mb-6">
            Once approved, Garmin will auto-sync completed workouts and daily
            health metrics.
          </p>
          <GarminConnect />
        </div>

        {/* Google Calendar Integration Section */}
        <div className="card card-pad mb-8">
          <h2 className="section-title mb-4">
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

"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { useRouter } from "next/navigation";
import Link from "next/link";

interface Session {
  day: string;
  discipline: string;
  type: string;
  duration: string;
  tss: number;
  instructions: string;
  pace: string;
}

interface Week {
  week: number;
  phase: string;
  summary: string;
  sessions: Session[];
}

export default function DashboardPage() {
  const { user, logout } = useAuth();
  const router = useRouter();
  const [profile, setProfile] = useState<any>({});
  const [plan, setPlan] = useState<Week[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [message, setMessage] = useState("");
  const [selectedWeek, setSelectedWeek] = useState(0);

  useEffect(() => {
    if (!user) {
      router.push("/login");
      return;
    }

    // Load profile from the database
    fetch(`/api/profile?userId=${user.id}`)
      .then((res) => (res.ok ? res.json() : {}))
      .then((data: any) => {
        if (data && !data.error) setProfile(data);
      })
      .catch((err) => console.error("Error loading profile:", err));

    // Load the latest saved plan from the database
    fetch(`/api/plans/latest?userId=${user.id}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: any) => {
        if (Array.isArray(data) && data.length > 0) setPlan(data);
      })
      .catch((err) => console.error("Error loading plan:", err));
  }, [user, router]);

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
        body: JSON.stringify({ userId: user?.id, ...profile }),
      });

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to generate plan");
      }

      const generatedPlan = await res.json();
      setPlan(generatedPlan.weeks || []);
      setMessage("Plan generated successfully!");
      setTimeout(() => setMessage(""), 3000);
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
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex justify-between items-center mb-8">
          <div>
            <h1 className="text-4xl font-bold text-indigo-900">TriApp Dashboard</h1>
            <p className="text-gray-600 mt-1">
              Logged in as: <strong>{user.email}</strong>
            </p>
          </div>
          <div className="flex gap-3">
            <Link
              href="/today"
              className="bg-indigo-600 text-white px-4 py-2 rounded-lg hover:bg-indigo-700"
            >
              Today
            </Link>
            <Link
              href="/profile"
              className="bg-indigo-600 text-white px-4 py-2 rounded-lg hover:bg-indigo-700"
            >
              Profile Settings
            </Link>
            <button
              onClick={() => {
                logout();
                router.push("/");
              }}
              className="bg-red-600 text-white px-4 py-2 rounded-lg hover:bg-red-700"
            >
              Logout
            </button>
          </div>
        </div>

        {/* Generate Plan Section */}
        <div className="bg-white rounded-lg shadow-lg p-8 mb-8">
          <h2 className="text-2xl font-bold text-indigo-900 mb-4">
            Generate Your Training Plan
          </h2>
          <p className="text-gray-600 mb-6">
            {profile.raceDate
              ? `Training for ${profile.raceType || "your"} race on ${new Date(profile.raceDate).toDateString()}`
              : "Set your race date in your profile to generate a plan"}
          </p>

          {message && (
            <div
              className={`px-4 py-3 rounded mb-4 ${
                message.includes("successfully")
                  ? "bg-green-100 text-green-700"
                  : "bg-red-100 text-red-700"
              }`}
            >
              {message}
            </div>
          )}

          <button
            onClick={handleGeneratePlan}
            disabled={isGenerating || !profile.raceDate}
            className="bg-indigo-600 text-white px-8 py-3 rounded-lg hover:bg-indigo-700 transition disabled:opacity-50 font-semibold"
          >
            {isGenerating ? "Generating Plan..." : "Generate AI Training Plan"}
          </button>
        </div>

        {/* Training Plan Display */}
        {plan.length > 0 && (
          <div className="bg-white rounded-lg shadow-lg p-8">
            <h2 className="text-2xl font-bold text-indigo-900 mb-6">
              Your Training Plan
            </h2>

            {/* Week Selector */}
            <div className="flex gap-2 mb-8 overflow-x-auto pb-2">
              {plan.map((week) => (
                <button
                  key={week.week}
                  onClick={() => setSelectedWeek(week.week - 1)}
                  className={`px-4 py-2 rounded-lg whitespace-nowrap font-semibold transition ${
                    selectedWeek === week.week - 1
                      ? "bg-indigo-600 text-white"
                      : "bg-gray-200 text-gray-700 hover:bg-gray-300"
                  }`}
                >
                  Week {week.week}
                </button>
              ))}
            </div>

            {/* Week Details */}
            {plan[selectedWeek] && (
              <div>
                <div className="mb-6">
                  <h3 className="text-xl font-bold text-indigo-900">
                    Week {plan[selectedWeek].week}: {plan[selectedWeek].phase}
                  </h3>
                  <p className="text-gray-600 mt-2">{plan[selectedWeek].summary}</p>
                </div>

                {/* Sessions Grid */}
                <div className="space-y-4">
                  {plan[selectedWeek].sessions.map((session, idx) => (
                    <div
                      key={idx}
                      className="border border-gray-200 rounded-lg p-4 hover:shadow-md transition"
                    >
                      <div className="flex justify-between items-start mb-3">
                        <div>
                          <h4 className="font-bold text-lg text-gray-800">
                            {session.day} - {session.discipline}
                          </h4>
                          <p className="text-sm text-indigo-600 font-semibold">
                            {session.type}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="text-sm text-gray-600">{session.duration}</p>
                          <p className="text-sm text-gray-600">TSS: {session.tss}</p>
                        </div>
                      </div>

                      <div className="bg-gray-50 rounded p-3 mb-3">
                        <p className="text-sm text-gray-700">
                          <strong>Instructions:</strong> {session.instructions}
                        </p>
                      </div>

                      <p className="text-sm text-gray-600">
                        <strong>Pace/Effort:</strong> {session.pace}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

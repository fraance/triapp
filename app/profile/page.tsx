"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { useRouter } from "next/navigation";

interface Profile {
  age?: number;
  gender?: string;
  raceDate?: string;
  raceType?: string;
  pastPerformance?: string;
  timezone?: string;
}

export default function ProfilePage() {
  const { user, logout } = useAuth();
  const router = useRouter();
  const [profile, setProfile] = useState<Profile>({});
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!user) {
      router.push("/login");
    } else {
      // Load profile from localStorage
      const stored = localStorage.getItem(`triapp_profile_${user.id}`);
      if (stored) {
        setProfile(JSON.parse(stored));
      }
    }
  }, [user, router]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setIsSaving(true);
    setMessage("");

    try {
      if (user) {
        localStorage.setItem(`triapp_profile_${user.id}`, JSON.stringify(profile));
        setMessage("Profile saved successfully!");
        setTimeout(() => setMessage(""), 3000);
      }
    } catch (error) {
      setMessage("An error occurred");
      console.error("Error saving profile:", error);
    } finally {
      setIsSaving(false);
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
      <div className="max-w-2xl mx-auto bg-white rounded-lg shadow-lg p-8">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-3xl font-bold text-indigo-900">Athlete Profile</h1>
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

        <p className="text-gray-600 mb-6">
          Logged in as: <strong>{user.email}</strong>
        </p>

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
                value={profile.raceDate || ""}
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

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Timezone
            </label>
            <input
              type="text"
              value={profile.timezone || ""}
              onChange={(e) =>
                setProfile({ ...profile, timezone: e.target.value || undefined })
              }
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder="e.g., UTC, America/New_York"
            />
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
    </div>
  );
}

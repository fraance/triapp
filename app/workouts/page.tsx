"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

interface Workout {
  id: string;
  name: string;
  startTime: Date;
  duration: number;
  sport: string;
  calories: number;
  avgHeartRate: number;
  maxHeartRate: number;
  distance: number;
  tss: number;
  description: string;
}

export default function WorkoutsPage() {
  const router = useRouter();
  const [workouts, setWorkouts] = useState<Workout[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    loadWorkouts();
  }, []);

  async function loadWorkouts() {
    try {
      setIsLoading(true);
      const res = await fetch("/api/garmin/workouts");

      if (!res.ok) {
        if (res.status === 401) {
          setConnected(false);
          setError("Not connected to Garmin. Please connect first.");
          return;
        }
        throw new Error("Failed to load workouts");
      }

      const data = await res.json();
      setWorkouts(data.workouts || []);
      setConnected(true);
    } catch (err: any) {
      setError(err.message || "Failed to load workouts");
      setConnected(false);
    } finally {
      setIsLoading(false);
    }
  }

  function formatDate(date: string | Date) {
    const d = new Date(date);
    return d.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function formatDistance(meters: number) {
    if (meters >= 1000) {
      return `${(meters / 1000).toFixed(2)} km`;
    }
    return `${meters} m`;
  }

  function formatDuration(seconds: number) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
  }

  const sportColors: { [key: string]: string } = {
    SWIMMING: "bg-blue-100 text-blue-800",
    CYCLING: "bg-green-100 text-green-800",
    RUNNING: "bg-red-100 text-red-800",
    STRENGTH: "bg-purple-100 text-purple-800",
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 py-12 px-4">
      <div className="max-w-6xl mx-auto">
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-3xl font-bold text-indigo-900">My Workouts</h1>
          <Link
            href="/profile"
            className="bg-indigo-600 text-white px-4 py-2 rounded-lg hover:bg-indigo-700 transition"
          >
            Back to Profile
          </Link>
        </div>

        {error && (
          <div className="bg-red-100 text-red-700 px-6 py-4 rounded-lg mb-8">
            {error}
          </div>
        )}

        {isLoading ? (
          <div className="bg-white rounded-lg shadow-lg p-8 text-center">
            <p className="text-gray-600">Loading workouts...</p>
          </div>
        ) : workouts.length === 0 ? (
          <div className="bg-white rounded-lg shadow-lg p-8 text-center">
            <p className="text-gray-600 mb-4">No workouts yet.</p>
            <button
              onClick={loadWorkouts}
              className="bg-indigo-600 text-white px-6 py-2 rounded-lg hover:bg-indigo-700 transition"
            >
              Refresh
            </button>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="bg-white rounded-lg shadow-lg p-6">
              <h2 className="text-xl font-bold text-indigo-900 mb-2">
                Total Workouts: {workouts.length}
              </h2>
              <p className="text-gray-600">
                Total TSS: {workouts.reduce((sum, w) => sum + w.tss, 0)}
              </p>
            </div>

            {workouts.map((workout) => (
              <div
                key={workout.id}
                className="bg-white rounded-lg shadow-lg p-6 hover:shadow-xl transition"
              >
                <div className="flex justify-between items-start mb-4">
                  <div>
                    <h3 className="text-2xl font-bold text-indigo-900">
                      {workout.name}
                    </h3>
                    <p className="text-sm text-gray-500">
                      {formatDate(workout.startTime)}
                    </p>
                  </div>
                  <div className="text-right">
                    <span
                      className={`inline-block px-4 py-2 rounded-full font-semibold ${
                        sportColors[workout.sport] ||
                        "bg-gray-100 text-gray-800"
                      }`}
                    >
                      {workout.sport}
                    </span>
                  </div>
                </div>

                <p className="text-gray-700 mb-4">{workout.description}</p>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                  <div className="bg-blue-50 p-4 rounded-lg">
                    <p className="text-sm text-gray-600">Duration</p>
                    <p className="text-lg font-bold text-indigo-900">
                      {formatDuration(workout.duration)}
                    </p>
                  </div>
                  <div className="bg-green-50 p-4 rounded-lg">
                    <p className="text-sm text-gray-600">Distance</p>
                    <p className="text-lg font-bold text-indigo-900">
                      {formatDistance(workout.distance)}
                    </p>
                  </div>
                  <div className="bg-purple-50 p-4 rounded-lg">
                    <p className="text-sm text-gray-600">Avg HR</p>
                    <p className="text-lg font-bold text-indigo-900">
                      {workout.avgHeartRate} bpm
                    </p>
                  </div>
                  <div className="bg-red-50 p-4 rounded-lg">
                    <p className="text-sm text-gray-600">TSS</p>
                    <p className="text-lg font-bold text-indigo-900">
                      {workout.tss}
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-sm text-gray-600">
                  <p>Calories: {workout.calories}</p>
                  <p>Max HR: {workout.maxHeartRate} bpm</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

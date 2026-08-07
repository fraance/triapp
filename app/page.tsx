"use client";

import Link from "next/link";
import { useAuth } from "@/lib/auth-context";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function Home() {
  const { user, isLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (user && !isLoading) {
      router.push("/today");
    }
  }, [user, isLoading, router]);

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen px-4">
        <span className="spinner spinner-lg" aria-hidden="true" />
      </div>
    );
  }

  return (
    <main className="min-h-screen flex flex-col justify-center px-6 sm:px-10 py-16">
      <div className="mx-auto w-full max-w-3xl">
        <span
          aria-hidden="true"
          className="inline-flex w-12 h-12 rounded-2xl bg-indigo-600 items-center justify-center text-white text-xl font-extrabold mb-10 shadow-lg shadow-indigo-600/25"
          style={{ fontStretch: "120%" }}
        >
          T
        </span>

        <p className="eyebrow mb-5">TriApp · Adaptive triathlon coaching</p>

        {/* One focal point, set as loud as the type will go. */}
        <h1 className="display">
          Train on
          <br />
          <span className="text-indigo-600">evidence</span>,
          <br />
          not guesswork.
        </h1>

        {/* The pitch is the coach speaking, so it is set in the serif. */}
        <p className="agent-voice mt-9 max-w-[46ch] text-gray-700">
          I read your Strava history, your race, and how your week actually
          went — then rebuild the plan around it. Every number I use, I show
          you where it came from.
        </p>

        <div className="mt-11 flex flex-col sm:flex-row gap-3">
          <Link href="/signup" className="btn btn-primary btn-lg">
            Get started
          </Link>
          <Link href="/login" className="btn btn-secondary btn-lg">
            Log in
          </Link>
        </div>

        <div className="mt-16 flex flex-wrap gap-x-8 gap-y-3">
          <p className="meta">Strava · Synced</p>
          <p className="meta">Thresholds · Measured</p>
          <p className="meta">Plan · Rebuilt daily</p>
        </div>
      </div>
    </main>
  );
}

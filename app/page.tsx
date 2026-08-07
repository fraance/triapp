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
    <main className="min-h-screen flex flex-col">
      <div className="border-b border-gray-200">
        <div className="mx-auto w-full max-w-5xl px-6 h-14 flex items-center justify-between">
          <span className="inline-flex items-baseline gap-1.5">
            <span className="text-[15px] font-extrabold uppercase tracking-[-0.04em] text-gray-950">
              TriApp
            </span>
            <span aria-hidden="true" className="w-1.5 h-1.5 bg-indigo-500" />
          </span>
          <p className="meta">Adaptive triathlon coaching</p>
        </div>
      </div>

      <div className="flex-1 mx-auto w-full max-w-5xl px-6 py-16 sm:py-24 flex flex-col justify-center">
        <p className="eyebrow mb-6">System / 01</p>

        <h1 className="display">
          Train on
          <br />
          evidence,
          <br />
          not guesswork
        </h1>

        <p className="agent-voice mt-8 max-w-[52ch]">
          TriApp reads your Strava history, your race, and how your week
          actually went — then rebuilds the plan around it. Every number it
          uses, it shows you where it came from.
        </p>

        <div className="mt-10 flex flex-col sm:flex-row gap-2">
          <Link href="/signup" className="btn btn-primary btn-lg">
            Get started
          </Link>
          <Link href="/login" className="btn btn-secondary btn-lg">
            Log in
          </Link>
        </div>

        {/* Dense, ruled, aligned — the product's own register, up front. */}
        <div className="metric-grid metric-grid-3 mt-16">
          <div>
            <p className="meta">Strava</p>
            <p className="numeral-sm font-mono mt-2 tracking-tight text-gray-950">
              SYNCED
            </p>
          </div>
          <div>
            <p className="meta">Thresholds</p>
            <p className="numeral-sm font-mono mt-2 tracking-tight text-gray-950">
              MEASURED
            </p>
          </div>
          <div>
            <p className="meta">Plan</p>
            <p className="numeral-sm font-mono mt-2 tracking-tight text-gray-950">
              REBUILT DAILY
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}

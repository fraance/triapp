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
        <p className="text-gray-600">Loading...</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen px-4">
      <div className="text-center max-w-md">
        <span className="inline-flex w-14 h-14 rounded-2xl bg-indigo-600 items-center justify-center text-white text-2xl font-extrabold mb-6 shadow-lg shadow-indigo-600/20">
          T
        </span>
        <h1 className="text-4xl font-bold text-indigo-900 mb-3 tracking-tight">
          Welcome to TriApp
        </h1>
        <p className="text-lg text-gray-600 mb-8">
          Your AI-powered triathlon training companion
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Link href="/login" className="btn btn-primary btn-lg">
            Log In
          </Link>
          <Link href="/signup" className="btn btn-secondary btn-lg">
            Sign Up
          </Link>
        </div>
      </div>
    </div>
  );
}
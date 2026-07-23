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
      router.push("/profile");
    }
  }, [user, isLoading, router]);

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100">
        <p className="text-xl text-gray-600">Loading...</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100">
      <div className="text-center">
        <h1 className="text-5xl font-bold text-indigo-900 mb-4">
          Welcome to TriApp
        </h1>
        <p className="text-xl text-indigo-700 mb-8">
          Your AI-powered triathlon training companion
        </p>
        <div className="flex gap-4 justify-center">
          <Link
            href="/login"
            className="bg-indigo-600 text-white px-8 py-3 rounded-lg hover:bg-indigo-700 transition font-semibold"
          >
            Log In
          </Link>
          <Link
            href="/signup"
            className="bg-white text-indigo-600 px-8 py-3 rounded-lg border-2 border-indigo-600 hover:bg-indigo-50 transition font-semibold"
          >
            Sign Up
          </Link>
        </div>
      </div>
    </div>
  );
}

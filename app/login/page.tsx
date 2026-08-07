"use client";

import { useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect } from "react";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const { login, user } = useAuth();
  const router = useRouter();

  /**
   * proxy.ts appends `?next=` when it bounces a signed-out visitor, so we can
   * return them to where they were actually headed instead of always dumping
   * them on /today. Read from `window.location` rather than useSearchParams so
   * this page doesn't need a Suspense boundary. Only same-origin paths are
   * accepted, to avoid an open redirect.
   */
  function destination() {
    if (typeof window === "undefined") return "/today";
    const next = new URLSearchParams(window.location.search).get("next");
    if (next && next.startsWith("/") && !next.startsWith("//")) return next;
    return "/today";
  }

  useEffect(() => {
    if (user) {
      router.replace(destination());
    }
  }, [user, router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setIsLoading(true);

    try {
      await login(email, password);
      router.replace(destination());
    } catch (err: any) {
      setError(err.message || "Login failed");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-5 py-12">
      <div className="w-full max-w-md">
        <div className="mb-9">
          <Link href="/" aria-label="TriApp home">
            <span
              aria-hidden="true"
              className="inline-flex w-11 h-11 rounded-2xl bg-indigo-600 items-center justify-center text-white text-lg font-extrabold mb-7 shadow-lg shadow-indigo-600/25"
              style={{ fontStretch: "120%" }}
            >
              T
            </span>
          </Link>
          <p className="eyebrow mb-4">Session · Sign in</p>
          <h1 className="page-title">Welcome back</h1>
          <p className="page-subtitle">Log in to your training plan.</p>
        </div>

        <form onSubmit={handleSubmit} className="card card-pad space-y-5">
          <div>
            <label className="label" htmlFor="login-email">
              Email
            </label>
            <input
              id="login-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              className="input"
              placeholder="you@example.com"
            />
          </div>

          <div>
            <label className="label" htmlFor="login-password">
              Password
            </label>
            <input
              id="login-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              className="input"
              placeholder="••••••••"
            />
          </div>

          {error && <div className="alert alert-danger">{error}</div>}

          <button type="submit" disabled={isLoading} className="btn btn-primary w-full btn-lg">
            {isLoading ? "Logging in..." : "Log In"}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-gray-600">
          Don&apos;t have an account?{" "}
          <Link
            href="/signup"
            className="text-indigo-700 font-semibold underline underline-offset-4"
          >
            Sign up
          </Link>
        </p>
      </div>
    </div>
  );
}

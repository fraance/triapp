"use client";

import { useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect } from "react";

export default function SignupPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const { signup, user } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (user) {
      router.push("/profile");
    }
  }, [user, router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    setIsLoading(true);

    try {
      await signup(email, password);
      router.push("/profile");
    } catch (err: any) {
      setError(err.message || "Signup failed");
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
          <p className="eyebrow mb-4">Account · Step 1 of 2</p>
          <h1 className="page-title">Create your account</h1>
          <p className="page-subtitle">
            Next you&apos;ll connect Strava, and the plan builds itself from
            there.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="card card-pad space-y-5">
          <div>
            <label className="label" htmlFor="signup-email">
              Email
            </label>
            <input
              id="signup-email"
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
            <label className="label" htmlFor="signup-password">
              Password
            </label>
            <input
              id="signup-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="new-password"
              className="input"
              placeholder="••••••••"
            />
          </div>

          <div>
            <label className="label" htmlFor="signup-confirm">
              Confirm Password
            </label>
            <input
              id="signup-confirm"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              autoComplete="new-password"
              className="input"
              placeholder="••••••••"
            />
          </div>

          {error && <div className="alert alert-danger">{error}</div>}

          <button type="submit" disabled={isLoading} className="btn btn-primary w-full btn-lg">
            {isLoading ? "Creating account..." : "Sign Up"}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-gray-600">
          Already have an account?{" "}
          <Link
            href="/login"
            className="text-indigo-700 font-semibold underline underline-offset-4"
          >
            Log in
          </Link>
        </p>
      </div>
    </div>
  );
}

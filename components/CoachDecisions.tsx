"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";

/**
 * Judgement calls the engine puts to the athlete.
 *
 * These used to be conversations with whoever was building the app — "your
 * plan starts conservative, is that what you want?" They belong here, where
 * the athlete can see the evidence and decide for themselves.
 *
 * Deliberately prominent and deliberately rare. Every question is cognitive
 * load, and v3's North Star spends that carefully.
 */

interface DecisionOption {
  id: string;
  label: string;
  detail: string;
  recommended?: boolean;
}

interface Decision {
  id: string;
  kind: string;
  question: string;
  context: string;
  options: DecisionOption[];
}

export default function CoachDecisions({ onChanged }: { onChanged?: () => void }) {
  const { user } = useAuth();
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const res = await fetch(`/api/coach/decisions?userId=${user.id}`);
      const json = await res.json();
      if (res.ok) setDecisions(json.decisions ?? []);
    } catch {
      /* supporting information — never break Today */
    }
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  async function answer(kind: string, optionId: string) {
    if (!user) return;
    setBusy(kind);
    setMessage("");
    try {
      const res = await fetch("/api/coach/decisions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, kind, answer: optionId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not save that");
      setMessage(json.warning ?? json.message ?? "Saved.");
      await load();
      if (json.rebuilt) onChanged?.();
    } catch (e: any) {
      setMessage(e.message);
    } finally {
      setBusy(null);
    }
  }

  if (decisions.length === 0 && !message) return null;

  return (
    <div className="mb-8">
      {message && (
        <div className="alert alert-info mb-3">
          <p>{message}</p>
        </div>
      )}

      {decisions.map((d) => (
        <div
          key={d.id}
          className="card card-pad mb-3 border-l-4 border-indigo-500"
        >
          <h2 className="text-lg font-bold text-indigo-900">{d.question}</h2>
          <p className="text-gray-700 mt-2">{d.context}</p>

          <div className="mt-4 space-y-2">
            {d.options.map((o) => (
              <button
                key={o.id}
                onClick={() => answer(d.kind, o.id)}
                disabled={busy === d.kind}
                className="block w-full text-left border border-gray-300 rounded-lg px-4 py-3 disabled:opacity-50 hover:border-indigo-400"
              >
                <span className="font-semibold text-gray-800">
                  {o.label}
                  {o.recommended && (
                    <span className="text-indigo-700 font-normal">
                      {" "}
                      · recommended
                    </span>
                  )}
                </span>
                <span className="block text-gray-600 text-sm mt-1">{o.detail}</span>
              </button>
            ))}
          </div>

          {busy === d.kind && (
            <p className="text-gray-500 text-sm mt-3">
              Applying that and rebuilding your plan — this takes a minute…
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

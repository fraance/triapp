"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { Thinking } from "@/components/ui";

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
    <div className="mb-8 space-y-3">
      {message && (
        <div className="alert alert-info">
          <p>{message}</p>
        </div>
      )}

      {decisions.map((d) => (
        <div key={d.id} className="card card-pad border-l-2 border-l-indigo-500">
          <p className="eyebrow mb-2.5">Your call</p>
          <h2 className="section-title">{d.question}</h2>
          <p className="agent-voice-sm mt-2.5">{d.context}</p>

          <div className="mt-5 space-y-2">
            {d.options.map((o) => (
              <button
                key={o.id}
                onClick={() => answer(d.kind, o.id)}
                disabled={busy === d.kind}
                className="block w-full text-left border border-gray-200 px-4 py-3
                  transition-colors disabled:opacity-40 hover:border-gray-950"
              >
                <span className="flex items-center gap-2.5 flex-wrap">
                  <span className="text-sm font-semibold tracking-[-0.015em] text-gray-950">
                    {o.label}
                  </span>
                  {o.recommended && (
                    <span className="badge badge-signal">Recommended</span>
                  )}
                </span>
                <span className="block text-sm text-gray-600 mt-1 leading-relaxed">
                  {o.detail}
                </span>
              </button>
            ))}
          </div>

          {busy === d.kind && (
            <div className="mt-4">
              <Thinking label="Applying that and rebuilding your plan / ~1 min" />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

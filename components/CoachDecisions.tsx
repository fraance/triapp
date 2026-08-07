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
        <div key={d.id} className="card card-pad">
          <p className="eyebrow mb-3">
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 rounded-full bg-indigo-500"
            />
            Your call
          </p>
          <h2 className="section-title">{d.question}</h2>
          {/* The context is the coach explaining itself — serif. */}
          <p className="agent-voice-sm mt-3 max-w-[58ch]">{d.context}</p>

          <div className="mt-6 space-y-2.5">
            {d.options.map((o) => (
              <button
                key={o.id}
                onClick={() => answer(d.kind, o.id)}
                disabled={busy === d.kind}
                className="group block w-full text-left rounded-2xl bg-gray-50 px-5 py-4
                  transition-colors disabled:opacity-50 hover:bg-indigo-50"
              >
                <span className="flex items-center gap-2.5 flex-wrap">
                  <span className="font-semibold text-gray-900 tracking-[-0.01em]">
                    {o.label}
                  </span>
                  {o.recommended && (
                    <span className="badge badge-brand">Recommended</span>
                  )}
                </span>
                <span className="block text-gray-600 text-sm mt-1.5 leading-relaxed">
                  {o.detail}
                </span>
              </button>
            ))}
          </div>

          {busy === d.kind && (
            <div className="mt-5">
              <Thinking label="Applying that and rebuilding your plan · ~1 min" />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

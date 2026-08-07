"use client";

import { segmentPhases } from "@/lib/session-phases";

/**
 * Renders a session's instructions as a chronological stack of phase cards
 * (warm-up / core / cool-down), each numbered so the athlete can follow the
 * workout in order. Unstructured instructions (recovery days) degrade to a
 * single card — never to nothing.
 */
export default function SessionPhases({ instructions }: { instructions: string }) {
  const phases = segmentPhases(instructions);

  if (phases.length === 0) return null;

  return (
    <div className="space-y-2">
      {phases.map((p) => (
        <div key={p.step} className="flex gap-3 items-start">
          <span
            className="shrink-0 w-7 h-7 rounded-full bg-indigo-100 text-indigo-900
              text-sm font-semibold flex items-center justify-center mt-0.5"
            aria-hidden
          >
            {p.step}
          </span>
          <div className="min-w-0">
            <p className="font-semibold text-gray-800 text-sm">{p.label}</p>
            <p className="text-gray-700 text-sm whitespace-pre-line">{p.body}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
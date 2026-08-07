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
    <div className="space-y-4">
      {phases.map((p) => (
        <div key={p.step} className="flex gap-3.5 items-start">
          <span
            className="shrink-0 w-6 h-6 rounded-full bg-white text-gray-500 shadow-xs
              font-mono text-[11px] font-semibold flex items-center justify-center mt-0.5"
            aria-hidden
          >
            {p.step}
          </span>
          <div className="min-w-0">
            <p className="meta meta-strong">{p.label}</p>
            <p className="text-gray-700 text-[15px] leading-relaxed mt-1 whitespace-pre-line">
              {p.body}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

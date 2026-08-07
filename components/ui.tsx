"use client";

import type { ReactNode } from "react";

/**
 * Shared UI primitives.
 *
 * These exist so every page renders the same loading state, page heading and
 * metric stat instead of each hand-copying the markup (which drifted the first
 * few times). They carry no styling beyond the design-system classes.
 */

export function Loading({ label = "Loading..." }: { label?: string }) {
  return (
    <div className="page-shell flex items-center justify-center">
      <div className="flex flex-col items-center gap-4">
        <span className="spinner spinner-lg" aria-hidden="true" />
        <p className="meta">{label}</p>
      </div>
    </div>
  );
}

/**
 * Page heading.
 *
 * `eyebrow` is the tiny monospaced label above the title — it names the region
 * so the display type is free to be short and loud rather than descriptive.
 */
export function PageHeader({
  title,
  subtitle,
  eyebrow,
  actions,
}: {
  title: string;
  subtitle?: string;
  eyebrow?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-8 sm:mb-10 flex items-end justify-between gap-4 flex-wrap">
      <div className="min-w-0">
        {eyebrow && <p className="eyebrow mb-3">{eyebrow}</p>}
        <h1 className="page-title">{title}</h1>
        {subtitle && <p className="page-subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}

/**
 * A single measurement.
 *
 * Label is monospaced and tracked out; the value is monospaced too, because
 * these are readings off the athlete's data rather than prose. Set
 * `text = true` for values that are words rather than numbers.
 */
export function Stat({
  label,
  value,
  valueClassName = "",
  hint,
  text = false,
}: {
  label: string;
  value: React.ReactNode;
  valueClassName?: string;
  hint?: string;
  text?: boolean;
}) {
  return (
    <div className="min-w-0">
      <p className="meta">{label}</p>
      <p
        className={`mt-1.5 ${
          text
            ? "text-lg font-semibold tracking-tight text-gray-900"
            : "numeral"
        } ${valueClassName}`}
      >
        {value}
      </p>
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}

/**
 * The agent is working. Shown instead of a frozen panel — exposing the work
 * is what makes the wait feel like computation rather than a hang.
 */
export function Thinking({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <span className="thinking" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      {label && <span className="meta">{label}</span>}
    </span>
  );
}

/**
 * Provenance / processing footnote: where a number came from, how long
 * something took, how many sources were read. Tiny, monospaced, unobtrusive —
 * present for trust, not for attention.
 */
export function MetaRow({ items }: { items: (string | null | undefined)[] }) {
  const shown = items.filter(Boolean) as string[];
  if (shown.length === 0) return null;
  return (
    <p className="meta flex flex-wrap items-center gap-x-2.5 gap-y-1">
      {shown.map((item, i) => (
        <span key={`${item}-${i}`} className="flex items-center gap-2.5">
          {i > 0 && <span aria-hidden="true">·</span>}
          {item}
        </span>
      ))}
    </p>
  );
}

/**
 * A welcoming blank canvas. An abstract mark plus a single obvious next step —
 * never a bare "no data" line.
 */
export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="card card-pad py-12 sm:py-16 text-center flex flex-col items-center">
      <span
        aria-hidden="true"
        className="mb-6 inline-flex h-16 w-16 items-center justify-center rounded-full bg-gray-50"
      >
        <span className="h-7 w-7 rounded-full bg-gradient-to-br from-indigo-400 to-indigo-600 opacity-80" />
      </span>
      <h3 className="section-title">{title}</h3>
      {body && <p className="page-subtitle mx-auto text-center">{body}</p>}
      {action && <div className="mt-7">{action}</div>}
    </div>
  );
}

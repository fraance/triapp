"use client";

import type { ReactNode } from "react";

/**
 * Shared UI primitives.
 *
 * These exist so every page renders the same loading state, page heading and
 * metric instead of each hand-copying the markup (which drifted the first few
 * times). They carry no styling beyond the design-system classes.
 */

export function Loading({ label = "Loading..." }: { label?: string }) {
  return (
    <div className="page-shell">
      <div className="page-inner flex items-center gap-3">
        <span className="spinner" aria-hidden="true" />
        <p className="meta">{label}</p>
      </div>
    </div>
  );
}

/**
 * Page heading.
 *
 * `eyebrow` is the monospaced micro-label above the title. It names the region
 * so the display setting stays short and hits hard rather than having to
 * describe itself.
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
    <header className="mb-7 border-b border-gray-200 pb-5">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          {eyebrow && <p className="eyebrow mb-2.5">{eyebrow}</p>}
          <h1 className="page-title">{title}</h1>
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      {subtitle && <p className="page-subtitle">{subtitle}</p>}
    </header>
  );
}

/**
 * A ruled grid of readings. Dense and column-aligned rather than a loose
 * vertical stack — figures should line up down the page so they can be
 * compared at a glance.
 */
export function MetricGrid({
  cols = 3,
  children,
  className = "",
}: {
  cols?: 2 | 3 | 4;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`metric-grid metric-grid-${cols} ${className}`}>
      {children}
    </div>
  );
}

/**
 * A single measurement: tracked-out micro-label over a large, tight,
 * tabular figure.
 *
 * `text` is for values that are words rather than numbers. `signal` marks a
 * live or active metric — one of only two places the accent colour is allowed.
 */
export function Stat({
  label,
  value,
  valueClassName = "",
  hint,
  text = false,
  signal = false,
}: {
  label: string;
  value: React.ReactNode;
  valueClassName?: string;
  hint?: string;
  text?: boolean;
  signal?: boolean;
}) {
  return (
    <div className="min-w-0">
      <p className="meta">{label}</p>
      <p
        className={`mt-2 ${
          text
            ? "text-sm font-semibold uppercase tracking-tight text-gray-950 truncate"
            : "numeral"
        } ${signal ? "numeral-signal" : ""} ${valueClassName}`}
      >
        {value}
      </p>
      {hint && <p className="meta mt-1.5">{hint}</p>}
    </div>
  );
}

/**
 * The agent is working. A scanning bar rather than a frozen panel — exposing
 * the work is what makes the wait read as computation rather than a hang.
 */
export function Thinking({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <span className="thinking" aria-hidden="true" />
      {label && <span className="meta">{label}</span>}
    </span>
  );
}

/**
 * Provenance / processing footnote: where a number came from, how long
 * something took, how many sources were read. Present for trust, not for
 * attention.
 */
export function MetaRow({ items }: { items: (string | null | undefined)[] }) {
  const shown = items.filter(Boolean) as string[];
  if (shown.length === 0) return null;
  return (
    <p className="meta flex flex-wrap items-center gap-x-2 gap-y-1">
      {shown.map((item, i) => (
        <span key={`${item}-${i}`} className="flex items-center gap-2">
          {i > 0 && <span aria-hidden="true" className="text-gray-300">/</span>}
          {item}
        </span>
      ))}
    </p>
  );
}

/**
 * A blank state with one obvious next step — never a bare "no data" line.
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
    <div className="card card-pad py-12 flex flex-col items-start">
      <span
        aria-hidden="true"
        className="mb-5 block h-[2px] w-10 bg-indigo-500"
      />
      <h3 className="section-title">{title}</h3>
      {body && <p className="page-subtitle max-w-[52ch]">{body}</p>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}

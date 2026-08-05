"use client";

/**
 * Tiny shared UI primitives.
 *
 * These exist so every page renders the same loading state, page heading and
 * metric stat instead of each hand-copying the markup (which drifted the first
 * few times). They carry no styling beyond the design-system classes.
 */

export function Loading({ label = "Loading..." }: { label?: string }) {
  return (
    <div className="page-shell flex items-center justify-center">
      <div className="flex flex-col items-center gap-3 text-gray-600">
        <span className="spinner spinner-lg" aria-hidden="true" />
        <p className="text-sm">{label}</p>
      </div>
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  return (
    <header className="mb-6">
      <h1 className="page-title">{title}</h1>
      {subtitle && <p className="page-subtitle">{subtitle}</p>}
    </header>
  );
}

export function Stat({
  label,
  value,
  valueClassName = "",
  hint,
}: {
  label: string;
  value: React.ReactNode;
  valueClassName?: string;
  hint?: string;
}) {
  return (
    <div>
      <p className="text-sm text-gray-500">{label}</p>
      <p className={`text-2xl font-bold text-indigo-900 ${valueClassName}`}>
        {value}
      </p>
      {hint && <p className="text-xs text-gray-400">{hint}</p>}
    </div>
  );
}
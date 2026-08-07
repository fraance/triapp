"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { NAV, activeNavItem, isPublicRoute } from "@/lib/routes";

/**
 * The app's only navigation. Rendered once from the root layout so every screen
 * keeps the same orientation - previously each page hand-rolled its own header
 * link row and no two pages agreed on what the menu was.
 *
 * Welded and ruled rather than floating: a hairline-bordered bar at the top on
 * desktop, a fixed tab bar at the bottom on mobile (this is an installable PWA,
 * so thumb-reachable navigation matters more than a header). The active tab is
 * marked with a 2px signal rule — the accent earns its place here because an
 * active tab is an active state.
 *
 * The bar reserves `env(safe-area-inset-bottom)` and `.page-shell` pads for its
 * full height, so no view can clip its own last action behind it.
 */

const ICONS: Record<string, React.ReactNode> = {
  "/today": (
    <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" strokeLinejoin="miter" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  ),
  "/season": (
    <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" strokeLinejoin="miter" aria-hidden="true">
      <rect x="3" y="4" width="18" height="18" />
      <path d="M16 2v4M8 2v4M3 10h18" />
      <path d="M8 15h3M8 18h6" />
    </svg>
  ),
  "/athlete": (
    <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" strokeLinejoin="miter" aria-hidden="true">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c0-4 3.6-6 8-6s8 2 8 6" />
    </svg>
  ),
  "/profile": (
    <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" strokeLinejoin="miter" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09A1.65 1.65 0 0 0 19.4 15Z" />
    </svg>
  ),
};

export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-baseline gap-1.5 ${className}`}>
      <span className="text-[15px] font-extrabold uppercase tracking-[-0.04em] text-gray-950">
        TriApp
      </span>
      <span
        aria-hidden="true"
        className="w-1.5 h-1.5 bg-indigo-500 translate-y-[-1px]"
      />
    </span>
  );
}

export default function Nav() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout } = useAuth();

  // Marketing splash, login and signup carry their own layout.
  if (isPublicRoute(pathname) || !user) return null;

  const active = activeNavItem(pathname);

  function handleLogout() {
    logout();
    router.push("/");
  }

  return (
    <>
      {/* ---------- Desktop / tablet: ruled top bar ---------- */}
      <header className="hidden sm:block sticky top-0 z-40 bar">
        <div className="max-w-5xl mx-auto px-6 flex items-stretch gap-8 h-14">
          <span className="flex items-center">
            <Wordmark />
          </span>
          <nav aria-label="Main" className="flex items-stretch gap-6">
            {NAV.map((item) => {
              const isActive = active?.href === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={isActive ? "page" : undefined}
                  className={`relative flex items-center text-[11px] font-semibold uppercase tracking-[0.1em] transition-colors ${
                    isActive
                      ? "text-gray-950"
                      : "text-gray-500 hover:text-gray-950"
                  }`}
                >
                  {item.label}
                  {isActive && (
                    <span
                      aria-hidden="true"
                      className="absolute inset-x-0 bottom-0 h-[2px] bg-indigo-500"
                    />
                  )}
                </Link>
              );
            })}
          </nav>
          <button
            onClick={handleLogout}
            className="ml-auto font-mono text-[0.65rem] font-medium uppercase tracking-[0.12em] text-gray-500 hover:text-gray-950 transition-colors"
          >
            Log out
          </button>
        </div>

        {/* Section sub-nav: keeps every page within two clicks. */}
        {active?.sub && (
          <div className="border-t border-gray-100">
            <div className="max-w-5xl mx-auto px-6 flex items-stretch gap-6 h-10 overflow-x-auto">
              {active.sub.map((child) => {
                const isHere = pathname === child.href;
                return (
                  <Link
                    key={child.href}
                    href={child.href}
                    aria-current={isHere ? "page" : undefined}
                    className={`relative flex items-center whitespace-nowrap font-mono text-[0.65rem] font-medium uppercase tracking-[0.12em] transition-colors ${
                      isHere
                        ? "text-gray-950"
                        : "text-gray-500 hover:text-gray-950"
                    }`}
                  >
                    {child.label}
                    {isHere && (
                      <span
                        aria-hidden="true"
                        className="absolute inset-x-0 bottom-0 h-[2px] bg-gray-950"
                      />
                    )}
                  </Link>
                );
              })}
            </div>
          </div>
        )}
      </header>

      {/* ---------- Mobile: section sub-nav at the top ---------- */}
      {active?.sub && (
        <div className="sm:hidden sticky top-0 z-40 bar">
          <div className="px-4 flex items-stretch gap-5 h-12 overflow-x-auto">
            {active.sub.map((child) => {
              const isHere = pathname === child.href;
              return (
                <Link
                  key={child.href}
                  href={child.href}
                  aria-current={isHere ? "page" : undefined}
                  className={`relative flex items-center whitespace-nowrap font-mono text-[0.65rem] font-medium uppercase tracking-[0.12em] ${
                    isHere ? "text-gray-950" : "text-gray-500"
                  }`}
                >
                  {child.label}
                  {isHere && (
                    <span
                      aria-hidden="true"
                      className="absolute inset-x-0 bottom-0 h-[2px] bg-gray-950"
                    />
                  )}
                </Link>
              );
            })}
          </div>
        </div>
      )}

      {/* ---------- Mobile: fixed tab bar ---------- */}
      <nav
        aria-label="Main"
        className="sm:hidden fixed bottom-0 inset-x-0 z-40 bar bar-top bg-white pb-[env(safe-area-inset-bottom)]"
      >
        <div className="flex">
          {NAV.map((item) => {
            const isActive = active?.href === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                className={`relative flex-1 flex flex-col items-center gap-1 py-2.5 font-mono text-[0.6rem] font-medium uppercase tracking-[0.1em] ${
                  isActive ? "text-gray-950" : "text-gray-500"
                }`}
              >
                {isActive && (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-0 top-0 h-[2px] bg-indigo-500"
                  />
                )}
                {ICONS[item.href]}
                {item.label}
              </Link>
            );
          })}
        </div>
      </nav>
    </>
  );
}

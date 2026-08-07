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
 * Desktop: a detached pill bar floating over the canvas. Mobile: a floating
 * bottom dock (this is an installable PWA, so thumb-reachable navigation
 * matters more than a header). Nothing is welded to the viewport edge — the
 * chrome should read as hovering above the page, not framing it.
 */

const ICONS: Record<string, React.ReactNode> = {
  "/today": (
    <svg viewBox="0 0 24 24" className="w-[22px] h-[22px]" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  ),
  "/season": (
    <svg viewBox="0 0 24 24" className="w-[22px] h-[22px]" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
      <path d="M8 15h3M8 18h6" />
    </svg>
  ),
  "/athlete": (
    <svg viewBox="0 0 24 24" className="w-[22px] h-[22px]" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c0-4 3.6-6 8-6s8 2 8 6" />
    </svg>
  ),
  "/profile": (
    <svg viewBox="0 0 24 24" className="w-[22px] h-[22px]" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09A1.65 1.65 0 0 0 19.4 15Z" />
    </svg>
  ),
};

export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <span
        aria-hidden="true"
        className="w-6 h-6 rounded-lg bg-indigo-600 inline-flex items-center justify-center text-white text-[11px] font-extrabold shadow-sm"
        style={{ fontStretch: "120%" }}
      >
        T
      </span>
      <span
        className="text-[15px] font-extrabold tracking-[-0.02em] text-gray-900"
        style={{ fontStretch: "115%" }}
      >
        TriApp
      </span>
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
      {/* ---------- Desktop / tablet: floating pill bar ---------- */}
      <header className="hidden sm:block sticky top-0 z-40 px-4 pt-4 pb-1">
        <div className="max-w-4xl mx-auto floating flex items-center gap-1 h-14 pl-5 pr-3">
          <Wordmark className="mr-4" />
          {NAV.map((item) => {
            const isActive = active?.href === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                className={`px-4 py-2 rounded-full text-sm font-semibold tracking-[-0.005em] transition-colors ${
                  isActive
                    ? "bg-gray-900 text-white"
                    : "text-gray-600 hover:text-gray-900 hover:bg-gray-900/[0.055]"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
          <button
            onClick={handleLogout}
            className="ml-auto px-3 py-2 font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-gray-500 hover:text-gray-900 transition-colors"
          >
            Log out
          </button>
        </div>

        {/* Section sub-nav: keeps every page within two clicks. */}
        {active?.sub && (
          <div className="max-w-4xl mx-auto px-2 pt-2.5">
            <div className="flex gap-1.5 items-center overflow-x-auto">
              {active.sub.map((child) => (
                <Link
                  key={child.href}
                  href={child.href}
                  aria-current={pathname === child.href ? "page" : undefined}
                  className={`px-3.5 py-1.5 rounded-full text-[13px] whitespace-nowrap transition-colors ${
                    pathname === child.href
                      ? "bg-white text-gray-900 font-semibold shadow-sm"
                      : "text-gray-500 hover:text-gray-900"
                  }`}
                >
                  {child.label}
                </Link>
              ))}
            </div>
          </div>
        )}
      </header>

      {/* ---------- Mobile: section sub-nav at the top ---------- */}
      {active?.sub && (
        <div className="sm:hidden sticky top-0 z-40 bg-[color:var(--canvas)]/85 backdrop-blur-xl">
          <div className="px-4 flex gap-1.5 h-14 items-center overflow-x-auto">
            {active.sub.map((child) => (
              <Link
                key={child.href}
                href={child.href}
                aria-current={pathname === child.href ? "page" : undefined}
                className={`px-3.5 py-1.5 rounded-full text-[13px] whitespace-nowrap ${
                  pathname === child.href
                    ? "bg-gray-900 text-white font-semibold"
                    : "text-gray-500"
                }`}
              >
                {child.label}
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* ---------- Mobile: floating bottom dock ---------- */}
      <nav
        aria-label="Main"
        className="sm:hidden fixed bottom-0 inset-x-0 z-40 px-3 pb-[calc(env(safe-area-inset-bottom)+0.625rem)] pt-2 pointer-events-none"
      >
        <div className="floating flex pointer-events-auto px-1.5 py-1.5">
          {NAV.map((item) => {
            const isActive = active?.href === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                className={`flex-1 flex flex-col items-center gap-1 py-2 rounded-full text-[10px] font-semibold tracking-[0.06em] uppercase transition-colors ${
                  isActive
                    ? "bg-gray-900 text-white"
                    : "text-gray-500"
                }`}
              >
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

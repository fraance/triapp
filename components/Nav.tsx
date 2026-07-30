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
 * Desktop: a top bar. Mobile: a bottom tab bar (this is an installable PWA, so
 * thumb-reachable navigation matters more than a header).
 */
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
      {/* ---------- Desktop / tablet: top bar ---------- */}
      <header className="hidden sm:block sticky top-0 z-40 bg-white border-b border-gray-200">
        <div className="max-w-3xl mx-auto px-4 flex items-center gap-1 h-14">
          <span className="font-bold text-indigo-900 mr-4">TriApp</span>
          {NAV.map((item) => {
            const isActive = active?.href === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                className={`px-3 py-2 rounded-lg text-sm font-medium ${
                  isActive
                    ? "bg-indigo-600 text-white"
                    : "text-gray-600 hover:bg-gray-100"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
          <button
            onClick={handleLogout}
            className="ml-auto text-sm text-gray-500 hover:text-gray-800"
          >
            Log out
          </button>
        </div>

        {/* Section sub-nav: keeps every page within two clicks. */}
        {active?.sub && (
          <div className="border-t border-gray-100 bg-gray-50">
            <div className="max-w-3xl mx-auto px-4 flex gap-1 h-11 items-center overflow-x-auto">
              {active.sub.map((child) => (
                <Link
                  key={child.href}
                  href={child.href}
                  aria-current={pathname === child.href ? "page" : undefined}
                  className={`px-3 py-1.5 rounded-md text-sm whitespace-nowrap ${
                    pathname === child.href
                      ? "bg-white text-indigo-700 border border-indigo-200 font-medium"
                      : "text-gray-600 hover:text-gray-900"
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
        <div className="sm:hidden sticky top-0 z-40 bg-white border-b border-gray-200">
          <div className="px-4 flex gap-1 h-12 items-center overflow-x-auto">
            {active.sub.map((child) => (
              <Link
                key={child.href}
                href={child.href}
                aria-current={pathname === child.href ? "page" : undefined}
                className={`px-3 py-1.5 rounded-md text-sm whitespace-nowrap ${
                  pathname === child.href
                    ? "bg-indigo-50 text-indigo-700 font-medium"
                    : "text-gray-600"
                }`}
              >
                {child.label}
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* ---------- Mobile: bottom tab bar ---------- */}
      <nav
        aria-label="Main"
        className="sm:hidden fixed bottom-0 inset-x-0 z-40 bg-white border-t border-gray-200 pb-[env(safe-area-inset-bottom)]"
      >
        <div className="flex">
          {NAV.map((item) => {
            const isActive = active?.href === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                className={`flex-1 text-center py-3 text-xs font-medium ${
                  isActive ? "text-indigo-600" : "text-gray-500"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </div>
      </nav>
    </>
  );
}

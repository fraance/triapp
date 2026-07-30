"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { isPublicRoute } from "@/lib/routes";

/**
 * The app's single client-side auth guard.
 *
 * Replaces the identical `useEffect -> router.push("/login")` block that was
 * copy-pasted into nine pages (and forgotten on /calendar and /workouts, which
 * were therefore public). proxy.ts already redirects unauthenticated requests
 * at the edge; this is the authoritative check, because the real session lives
 * in localStorage and the edge can only see the presence cookie.
 */
export default function AuthGuard({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  const isPublic = isPublicRoute(pathname);

  useEffect(() => {
    if (isLoading) return;
    if (!user && !isPublic) router.replace("/login");
  }, [user, isLoading, isPublic, router]);

  // Don't render protected content until we know who the user is, otherwise
  // pages fire API calls with a null user and flash before redirecting.
  if (!isPublic && (isLoading || !user)) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-gray-600">Loading...</p>
      </div>
    );
  }

  return <>{children}</>;
}

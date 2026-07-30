import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isPublicRoute, AUTH_COOKIE } from "@/lib/routes";

/**
 * Optimistic auth redirect at the edge.
 *
 * The real session lives in localStorage (see lib/auth-context), which the edge
 * cannot read, so this only checks the presence cookie the AuthProvider mirrors
 * alongside it. Per the Next.js docs, Proxy is for optimistic checks only - it
 * is NOT the authorisation boundary. <AuthGuard> is the authoritative
 * client-side check and every API route verifies the user itself.
 *
 * Its job here is purely UX: send signed-out visitors to /login before a
 * protected page renders, instead of flashing it and bouncing.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isPublicRoute(pathname)) return NextResponse.next();
  if (request.cookies.has(AUTH_COOKIE)) return NextResponse.next();

  const login = new URL("/login", request.url);
  // Remember where they were headed so we can return them after signing in.
  login.searchParams.set("next", pathname);
  return NextResponse.redirect(login);
}

export const config = {
  // Skip API routes (they do their own auth), Next internals and static assets.
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|manifest.webmanifest|icon-.*\\.png|apple-touch-icon.png).*)",
  ],
};

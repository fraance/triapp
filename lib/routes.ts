/**
 * Single source of truth for the app's navigation structure.
 *
 * Shared by the <Nav> component, <AuthGuard>, and proxy.ts so the menu, the
 * client-side guard and the edge redirect can never drift apart.
 *
 * The four top-level destinations map to the four questions an athlete asks:
 *   Today    - what do I do today?
 *   Plan     - where is this going?
 *   Me       - what does the coach know about me?
 *   Settings - is my data flowing in?
 *
 * `sub` entries keep every existing page reachable in at most two clicks while
 * the section merges happen incrementally.
 */

export interface NavChild {
  label: string;
  href: string;
}

export interface NavItem {
  label: string;
  href: string;
  /** Pathnames that should light this tab up as active. */
  match: string[];
  sub?: NavChild[];
}

export const NAV: NavItem[] = [
  {
    label: "Today",
    href: "/today",
    match: ["/today"],
  },
  {
    label: "Plan",
    href: "/season",
    match: ["/season"],
  },
  {
    label: "Me",
    href: "/athlete",
    match: ["/athlete", "/race", "/availability", "/documents"],
    sub: [
      { label: "Athlete", href: "/athlete" },
      { label: "Race", href: "/race" },
      { label: "My time", href: "/availability" },
      { label: "Files", href: "/documents" },
    ],
  },
  {
    label: "Settings",
    href: "/profile",
    match: ["/profile", "/strava", "/calendar", "/workouts"],
    sub: [
      { label: "Account & plan", href: "/profile" },
      { label: "Strava", href: "/strava" },
      { label: "Garmin", href: "/workouts" },
      { label: "Calendar", href: "/calendar" },
    ],
  },
];

/** Routes reachable without a session. Everything else requires one. */
export const PUBLIC_ROUTES = ["/", "/login", "/signup"];

export function isPublicRoute(pathname: string): boolean {
  return PUBLIC_ROUTES.includes(pathname);
}

/** The top-level nav item that owns a given pathname, if any. */
export function activeNavItem(pathname: string): NavItem | undefined {
  return NAV.find((item) => item.match.includes(pathname));
}

/**
 * Presence-only cookie mirroring the localStorage session, so proxy.ts can do
 * an optimistic redirect and avoid the "flash of protected page" before the
 * client-side guard runs. It carries no identity and is NOT an authorisation
 * check - every API route still verifies the user itself.
 */
export const AUTH_COOKIE = "triapp_auth";

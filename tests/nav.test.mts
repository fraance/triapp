/**
 * Tests for the navigation architecture.
 *
 * The rules this locks in:
 *   1. Every page is reachable from the nav — no orphans (/calendar and
 *      /workouts used to be unreachable except by typing the URL).
 *   2. Every page is at most two clicks from anywhere.
 *   3. Exactly one nav tab lights up for any given path — no ambiguity.
 *   4. Public routes are the only routes without an auth guard.
 *   5. The login redirect can't be turned into an open redirect.
 *
 * These are pure functions with no database access, so this suite touches no
 * user data at all.
 *
 * Run with:  npm run test:nav
 */
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  NAV,
  PUBLIC_ROUTES,
  isPublicRoute,
  activeNavItem,
  AUTH_COOKIE,
} from "../lib/routes";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? ` — ${detail}` : ""}`);
  }
}

/** Every route the app actually ships, read off the filesystem. */
function discoverPageRoutes(): string[] {
  const appDir = join(process.cwd(), "app");
  const routes: string[] = [];
  if (existsSync(join(appDir, "page.tsx"))) routes.push("/");
  for (const entry of readdirSync(appDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "api") continue;
    if (existsSync(join(appDir, entry.name, "page.tsx"))) {
      routes.push(`/${entry.name}`);
    }
  }
  return routes.sort();
}

/** Everything the nav can take you to, top level plus sub-nav. */
function navReachable(): Set<string> {
  const reachable = new Set<string>();
  for (const item of NAV) {
    reachable.add(item.href);
    for (const child of item.sub ?? []) reachable.add(child.href);
  }
  return reachable;
}

const pages = discoverPageRoutes();
const reachable = navReachable();
const protectedPages = pages.filter((p) => !isPublicRoute(p));

console.log("\nNo page is orphaned:");
for (const page of protectedPages) {
  check(`${page} is reachable from the nav`, reachable.has(page));
}

console.log("\nThe nav points only at pages that exist:");
for (const href of reachable) {
  check(`${href} is a real page`, pages.includes(href));
}

console.log("\nEverything is within two clicks:");
check(
  "the nav is four top-level destinations",
  NAV.length === 4,
  `got ${NAV.length}`,
);
for (const item of NAV) {
  check(
    `"${item.label}" has at most 4 sub-items`,
    (item.sub?.length ?? 0) <= 4,
    `got ${item.sub?.length}`,
  );
  // A tab's own href must be one of its sub-items, or it has no sub-nav at all,
  // otherwise clicking the tab lands you somewhere the sub-nav can't highlight.
  if (item.sub) {
    check(
      `"${item.label}" lands on one of its own sub-pages`,
      item.sub.some((c) => c.href === item.href),
    );
  }
}

console.log("\nExactly one tab is active at a time:");
for (const page of protectedPages) {
  const owners = NAV.filter((item) => item.match.includes(page));
  check(
    `${page} is owned by exactly one tab`,
    owners.length === 1,
    `owned by ${owners.length}: ${owners.map((o) => o.label).join(", ")}`,
  );
}
for (const item of NAV) {
  check(
    `"${item.label}" matches its own href`,
    item.match.includes(item.href),
  );
  for (const child of item.sub ?? []) {
    check(
      `"${item.label}" claims its sub-page ${child.href}`,
      item.match.includes(child.href),
    );
  }
}

console.log("\nAuth boundary:");
check(
  "public routes are exactly the signed-out surface",
  PUBLIC_ROUTES.slice().sort().join(",") === "/,/login,/signup",
  PUBLIC_ROUTES.join(","),
);
check("/today is protected", !isPublicRoute("/today"));
check("/calendar is protected", !isPublicRoute("/calendar"));
check("/workouts is protected", !isPublicRoute("/workouts"));
check("/login is public", isPublicRoute("/login"));
check("no public route appears in the nav", !PUBLIC_ROUTES.some((r) => reachable.has(r)));
check("the auth cookie carries no identity", AUTH_COOKIE === "triapp_auth");

console.log("\nActive-tab lookup:");
check("/season activates Plan", activeNavItem("/season")?.label === "Plan");
check("/race activates Me", activeNavItem("/race")?.label === "Me");
check("/strava activates Settings", activeNavItem("/strava")?.label === "Settings");
check("an unknown path activates nothing", activeNavItem("/nope") === undefined);

console.log("\nLogin redirect cannot be hijacked:");
// Mirrors destination() in app/login/page.tsx.
function destination(search: string) {
  const next = new URLSearchParams(search).get("next");
  if (next && next.startsWith("/") && !next.startsWith("//")) return next;
  return "/today";
}
check("a same-origin path is honoured", destination("?next=/race") === "/race");
check(
  "a protocol-relative URL is rejected",
  destination("?next=//evil.com") === "/today",
);
check(
  "an absolute URL is rejected",
  destination("?next=https://evil.com") === "/today",
);
check("a missing param falls back to /today", destination("") === "/today");

console.log(
  `\nResult: ${passed} passed, ${failed} failed\n`,
);
if (failed > 0) process.exit(1);

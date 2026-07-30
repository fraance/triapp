import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

/**
 * Deployment health check.
 *
 * Reports whether each required setting is present and whether the database
 * is reachable. It NEVER returns the values themselves — only whether they
 * are set — so it is safe to call on a public deployment.
 */
export async function GET() {
  const required = [
    "DATABASE_URL",
    "OPENAI_API_KEY",
    "STRAVA_CLIENT_ID",
    "STRAVA_CLIENT_SECRET",
    "STRAVA_REDIRECT_URI",
  ];

  const settings: Record<string, string> = {};
  for (const key of required) {
    const value = process.env[key];
    settings[key] = value ? `set (${value.length} chars)` : "MISSING";
  }

  // Show only the host we're trying to reach — never the credentials.
  let databaseHost = "unknown";
  const url = process.env.DATABASE_URL;
  if (url) {
    try {
      const parsed = new URL(url);
      databaseHost = `${parsed.hostname}:${parsed.port || "5432"}`;
    } catch {
      databaseHost = "DATABASE_URL is not a valid URL";
    }
  }

  let database = "not tested";
  let userCount: number | null = null;
  let databaseError: string | null = null;

  try {
    userCount = await prisma.user.count();
    database = "connected";
  } catch (error: any) {
    database = "FAILED";
    databaseError = (error?.message || String(error)).slice(0, 300);
  }

  const healthy = database === "connected" && !Object.values(settings).includes("MISSING");

  return NextResponse.json(
    {
      healthy,
      database,
      databaseHost,
      userCount,
      databaseError,
      settings,
    },
    { status: healthy ? 200 : 503 }
  );
}

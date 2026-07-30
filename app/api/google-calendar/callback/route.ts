import { NextResponse } from "next/server";

/** Calendar OAuth is not configured — the integration has not been built. */
export async function GET() {
  return NextResponse.json(
    { available: false, reason: "Calendar sync has not been built yet." },
    { status: 503 }
  );
}

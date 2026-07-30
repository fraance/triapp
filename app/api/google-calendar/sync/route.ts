import { NextResponse } from "next/server";

/** Calendar sync has not been built yet. */
export async function POST() {
  return NextResponse.json(
    { available: false, reason: "Calendar sync has not been built yet." },
    { status: 503 }
  );
}

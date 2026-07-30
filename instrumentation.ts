/**
 * Runs once when a Next.js server instance starts.
 *
 * Kept deliberately light: `register` must finish before the server accepts
 * requests, so this only arms a timer — it does not sync inline.
 */
export async function register() {
  // Skip the Edge runtime and the build step; timers only make sense in the
  // long-lived Node server.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { startBackgroundSync } = await import("./lib/scheduler");
  startBackgroundSync();
}

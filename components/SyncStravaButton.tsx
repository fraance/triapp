"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

/**
 * Lets the athlete trigger a Strava sync whenever they want, rather than
 * waiting for the hourly background job — useful right after finishing a
 * session, when they want the plan to catch up immediately.
 *
 * Reuses the same sync-then-reconcile-then-adapt endpoint the Strava settings
 * page calls, so a sync triggered from here behaves identically.
 */
export default function SyncStravaButton({
  userId,
  onSynced,
}: {
  userId: string;
  onSynced?: () => void;
}) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/strava/status?userId=${userId}`)
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setConnected(Boolean(d.connected));
      })
      .catch(() => {
        if (!cancelled) setConnected(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  async function sync() {
    setSyncing(true);
    setMessage("");
    try {
      const res = await fetch("/api/strava/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Sync failed");

      const parts = [
        `${data.added} new activit${data.added === 1 ? "y" : "ies"}.`,
      ];
      if (data.reconciled > 0) {
        parts.push(`${data.reconciled} session${data.reconciled === 1 ? "" : "s"} updated.`);
      }
      if (data.adapted) parts.push("Plan adapted.");
      setMessage(parts.join(" "));
      onSynced?.();
    } catch (e: any) {
      setMessage(e.message || "Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  // Still checking — render nothing rather than flash a button that's about
  // to disappear.
  if (connected === null) return null;

  if (!connected) {
    return (
      <Link href="/strava" className="btn btn-secondary btn-sm">
        Connect Strava
      </Link>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {message && <span className="meta">{message}</span>}
      <button
        type="button"
        onClick={sync}
        disabled={syncing}
        className="btn btn-secondary btn-sm"
      >
        {syncing ? "Syncing…" : "Sync Strava"}
      </button>
    </div>
  );
}
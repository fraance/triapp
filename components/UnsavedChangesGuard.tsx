"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Stops unsaved calendar changes from disappearing silently.
 *
 * Two escape routes have to be covered, and only one of them is ours:
 *
 *  - Closing or reloading the tab. The browser owns that dialog; all we can do
 *    is set `returnValue` on `beforeunload` and let it ask its own generic
 *    question. We cannot offer to save from there.
 *  - Navigating inside the app. This we control, so we ask properly: Save,
 *    Discard, or Keep editing. Links are intercepted in the capture phase
 *    before Next's router sees the click, because once navigation starts the
 *    App Router gives us no way to stop it.
 *
 * Deliberately not blocked: the browser Back button. `popstate` fires after
 * the fact, so "blocking" it means pushing the user back to a URL they didn't
 * ask for, which is worse than losing a draft. Back discards, as it always has.
 */
export default function UnsavedChangesGuard({
  when,
  onSave,
  saving = false,
  message = "You have unsaved changes to your plan.",
  error = null,
}: {
  /** Is there anything worth protecting? */
  when: boolean;
  /** Persist the draft. Resolve true if it saved and we may continue. */
  onSave: () => Promise<boolean>;
  saving?: boolean;
  message?: string;
  /**
   * Why the last save failed. The page writes its error to the screen *behind*
   * this dialog, where it cannot be read — so a rejected save looked like the
   * app simply refusing to let the athlete leave, with Discard the only way
   * out. The reason has to appear here.
   */
  error?: string | null;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  // Read inside listeners that are registered once, so they never see a stale
  // value from the render they were created in.
  const active = useRef(when);
  active.current = when;

  // ---- Leaving the site entirely ----------------------------------------
  useEffect(() => {
    if (!when) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [when]);

  // ---- Navigating within the app ----------------------------------------
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!active.current) return;
      // Let the user open things in a new tab without being interrogated.
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
        return;
      if (e.button !== 0) return;

      const anchor = (e.target as HTMLElement | null)?.closest?.("a[href]") as
        | HTMLAnchorElement
        | null;
      if (!anchor) return;
      if (anchor.target && anchor.target !== "_self") return;
      if (anchor.hasAttribute("download")) return;

      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname) return;

      e.preventDefault();
      e.stopPropagation();
      setPending(url.pathname + url.search);
    };

    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  function leave() {
    const to = pending;
    setPending(null);
    setFailed(false);
    // Let the dialog close before the route changes, so the guard is inactive
    // by the time the click listener would see the navigation.
    active.current = false;
    if (to) router.push(to);
  }

  const [failed, setFailed] = useState(false);

  async function saveThenLeave() {
    setFailed(false);
    const ok = await onSave();
    if (ok) {
      leave();
      return;
    }
    // The draft is kept rather than thrown away on the athlete's behalf, and
    // the reason is shown here so they can act on it.
    setFailed(true);
  }

  if (!pending) return null;

  return (
    <div className="fixed inset-0 z-50 bg-gray-950/50 flex items-end sm:items-center justify-center p-4">
      <div className="card w-full max-w-sm p-6 shadow-xl">
        <p className="eyebrow mb-3">Unsaved draft</p>
        <h2 className="section-title mb-2">Save your changes?</h2>
        <p className="section-subtitle mb-6">{message}</p>

        {failed && (
          <div className="alert alert-danger mb-5">
            <p className="font-semibold mb-1">That didn&apos;t save.</p>
            <p>
              {error ||
                "Something rejected the change. Keep editing to fix it, or discard."}
            </p>
          </div>
        )}
        <div className="flex flex-col gap-2">
          <button
            onClick={saveThenLeave}
            disabled={saving}
            className="btn btn-primary w-full"
          >
            {saving ? "Saving…" : failed ? "Try saving again" : "Save and leave"}
          </button>
          <button
            onClick={leave}
            disabled={saving}
            className="btn btn-danger-soft w-full"
          >
            Discard changes
          </button>
          <button
            onClick={() => setPending(null)}
            disabled={saving}
            className="btn btn-secondary w-full"
          >
            {failed ? "Go back and fix it" : "Keep editing"}
          </button>
        </div>
      </div>
    </div>
  );
}

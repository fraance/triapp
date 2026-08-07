"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { Thinking } from "@/components/ui";

/**
 * Tell the coach what's going on, in your own words.
 *
 * Lives on Today rather than its own route: the nav permits no orphan pages
 * and no more than four sub-items per tab, and this is a "what do I do today"
 * question anyway.
 *
 * The coach's replies are the only serif text in the product. That is the
 * whole typographic contract: sans-serif is the application talking, serif is
 * the coach talking. What matters is that the reply states the reasoning and
 * the plan visibly changes.
 */

interface Message {
  id: string;
  rawText: string;
  reply: string | null;
  createdAt: string;
}

const EXAMPLES = [
  "Slept badly and my left calf is sore",
  "I won't have my bike for the next 4 days",
  "At the beach this weekend, open water swimming only",
];

/** Timestamps are metadata, so they render in the mono register. */
function stamp(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d
    .toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    .toUpperCase();
}

export default function CoachChat({ onChanged }: { onChanged?: () => void }) {
  const { user } = useAuth();
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const res = await fetch(`/api/coach/chat?userId=${user.id}`);
      const json = await res.json();
      if (res.ok) setMessages(json.messages ?? []);
    } catch {
      /* the panel is supporting information — never break Today */
    }
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  async function send(body: string) {
    if (!user || !body.trim() || busy) return;
    setBusy(true);
    setError("");

    // Show what they said straight away; the reply takes a few seconds.
    const pending: Message = {
      id: `pending-${Date.now()}`,
      rawText: body,
      reply: null,
      createdAt: new Date().toISOString(),
    };
    setMessages((m) => [...m, pending]);
    setText("");

    try {
      const res = await fetch("/api/coach/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, message: body }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not send that");

      setMessages((m) =>
        m.map((msg) =>
          msg.id === pending.id ? { ...msg, reply: json.reply } : msg
        )
      );
      // The plan may have moved underneath us.
      if (json.changes?.length || json.scheduleChange?.applied) onChanged?.();
      await load();
    } catch (e: any) {
      setError(e.message);
      setMessages((m) => m.filter((msg) => msg.id !== pending.id));
      setText(body);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card card-pad">
      <p className="eyebrow mb-3">Coach · Conversational</p>
      <h2 className="section-title">Tell your coach</h2>
      <p className="section-subtitle mt-2 max-w-[46ch]">
        How you&apos;re feeling, what you won&apos;t have access to, or ask it to
        move or swap a session. The plan adjusts itself.
      </p>

      {messages.length > 0 && (
        <div className="mt-7 space-y-7 max-h-[26rem] overflow-y-auto pr-1">
          {messages.map((m) => (
            <div key={m.id}>
              {/* The athlete: their own words, in the app's own voice. */}
              <div className="flex justify-end">
                <p className="max-w-[85%] rounded-3xl rounded-br-lg bg-gray-50 px-4 py-2.5 text-[15px] leading-relaxed text-gray-800">
                  {m.rawText}
                </p>
              </div>

              {/* The coach: serif, unboxed, given room. */}
              <div className="mt-4 pl-1">
                <p className="eyebrow mb-2">
                  <span
                    aria-hidden="true"
                    className="h-1.5 w-1.5 rounded-full bg-indigo-500"
                  />
                  Coach
                  {m.reply && stamp(m.createdAt) && (
                    <span className="opacity-55">{stamp(m.createdAt)}</span>
                  )}
                </p>
                {m.reply ? (
                  <p className="agent-voice max-w-[62ch] whitespace-pre-line">
                    {m.reply}
                  </p>
                ) : (
                  <Thinking label="Working out what that means for your week" />
                )}
              </div>
            </div>
          ))}
          <div ref={endRef} />
        </div>
      )}

      {/* Guided next steps: never make the athlete start from a blank box. */}
      {messages.length === 0 && (
        <div className="mt-6">
          <p className="eyebrow mb-3">Try</p>
          <div className="flex flex-wrap gap-2">
            {EXAMPLES.map((e) => (
              <button
                key={e}
                onClick={() => send(e)}
                disabled={busy}
                className="pill"
              >
                {e}
              </button>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div className="alert alert-danger mt-5">{error}</div>
      )}

      <div className="mt-6 flex items-end gap-2.5">
        <textarea
          className="textarea flex-1 resize-none"
          rows={2}
          placeholder="e.g. no bike until Thursday, my Achilles is sore, or move Thursday's swim to Saturday"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(text);
            }
          }}
          disabled={busy}
        />
        <button
          onClick={() => send(text)}
          disabled={busy || !text.trim()}
          className="btn btn-primary"
        >
          {busy ? "Thinking…" : "Send"}
        </button>
      </div>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth-context";

/**
 * Tell the coach what's going on, in your own words.
 *
 * Lives on Today rather than its own route: the nav permits no orphan pages
 * and no more than four sub-items per tab, and this is a "what do I do today"
 * question anyway.
 *
 * Deliberately plain. What matters is that the reply states the reasoning and
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
      if (json.changes?.length) onChanged?.();
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
    <div className="bg-white rounded-lg shadow p-4">
      <h2 className="text-xl font-bold text-indigo-900 mb-1">Tell your coach</h2>
      <p className="text-gray-600 text-sm mb-3">
        How you&apos;re feeling, or what you won&apos;t have access to. The plan
        adjusts itself.
      </p>

      {messages.length > 0 && (
        <div className="space-y-3 mb-4 max-h-96 overflow-y-auto">
          {messages.map((m) => (
            <div key={m.id}>
              <p className="text-gray-800 bg-indigo-50 rounded px-3 py-2">
                {m.rawText}
              </p>
              {m.reply ? (
                <p className="text-gray-700 px-3 py-2">{m.reply}</p>
              ) : (
                <p className="text-gray-400 px-3 py-2 text-sm">
                  Working out what that means for your week…
                </p>
              )}
            </div>
          ))}
          <div ref={endRef} />
        </div>
      )}

      {messages.length === 0 && (
        <div className="mb-3 flex flex-wrap gap-2">
          {EXAMPLES.map((e) => (
            <button
              key={e}
              onClick={() => send(e)}
              disabled={busy}
              className="text-sm text-indigo-700 border border-indigo-200 rounded-full px-3 py-1 disabled:opacity-50"
            >
              {e}
            </button>
          ))}
        </div>
      )}

      {error && <p className="text-red-700 text-sm mb-2">{error}</p>}

      <div className="flex gap-2">
        <textarea
          className="border border-gray-300 rounded px-3 py-2 flex-1 resize-none"
          rows={2}
          placeholder="e.g. no bike until Thursday, and my Achilles is a bit sore"
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
          className="bg-indigo-600 text-white px-5 py-2 rounded-lg disabled:opacity-50 self-end"
        >
          {busy ? "Thinking…" : "Send"}
        </button>
      </div>
    </div>
  );
}

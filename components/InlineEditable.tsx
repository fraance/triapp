"use client";

import { useRef, useState, useEffect } from "react";

/**
 * An inline, click-to-edit field.
 *
 * Clicking the read value turns it into an input (or textarea for multi-line)
 * with the caret placed where you clicked. Enter (or blur) commits, Escape
 * cancels. `onSave` returns the new value, or undefined to decline.
 *
 * UI is deliberately minimal (project rule 4): the only affordance is a dotted
 * underline and an I-beam cursor on hover, plus a faint tint while focused.
 */
export default function InlineEditable({
  value,
  onSave,
  placeholder,
  multiline = false,
  className = "",
  label,
}: {
  value: string;
  onSave: (next: string) => void;
  placeholder?: string;
  multiline?: boolean;
  className?: string;
  label?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) return;
    setDraft(value);
    const el = ref.current;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [editing, value]);

  function commit() {
    if (draft.trim() !== value) onSave(draft.trim());
    setEditing(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (multiline) {
      // Enter inserts a new line; nothing commits the editor except blur/Escape.
      return;
    }
    if (e.key === "Enter") commit();
    if (e.key === "Escape") setEditing(false);
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={(e) => {
          setEditing(true);
          e.stopPropagation();
        }}
        className={
          "group/editable cursor-text text-left rounded px-0.5 -mx-0.5 " +
          "hover:bg-gray-100 transition-colors " +
          className
        }
        aria-label={label ? `Edit ${label}` : "Click to edit"}
        title={label ? `Click to edit ${label}` : "Click to edit"}
      >
        <span className="border-b border-dotted border-gray-400 group-hover/editable:border-indigo-500">
          {value || (
            <span className="text-gray-400 italic">{placeholder ?? "—"}</span>
          )}
        </span>
      </button>
    );
  }

  const shared = {
    ref: ref as React.Ref<any>,
    value: draft,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setDraft(e.target.value),
    onBlur: commit,
    onKeyDown,
    placeholder,
    className:
      "border border-indigo-300 rounded px-1 py-0.5 text-inherit " +
      "outline-none focus:ring-1 focus:ring-indigo-400 " +
      className,
    onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
  };

  return multiline ? (
    <textarea rows={3} {...(shared as any)} />
  ) : (
    <input {...(shared as any)} />
  );
}
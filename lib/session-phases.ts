/**
 * Segments a free-text session description into chronological coaching phases
 * (warm-up / core / cool-down), so the detail view renders the workout as a
 * stack of numbered cards instead of one undifferentiated paragraph.
 *
 * The AI coach writes instructions as a single prose string with a consistent
 * but not rigid shape, for example:
 *   "Warm-up 400m easy. Main: 10x50m technique drills, 20s rest. Cool-down 300m."
 * and sometimes without explicit markers (recovery days):
 *   "Easy swim focusing on form, no sets."
 *
 * This parser is deliberately forgiving: it only needs to find the boundaries
 * between the standard phases, and falls back to a single card when the text
 * is unstructured. It never invents content (project rule 2) — every word the
 * UI shows comes straight from the source string.
 */

export interface Phase {
  /** 1-based chronological position in the workout. */
  step: number;
  label: string;
  body: string;
}

const MARKERS: Record<string, string[]> = {
  warm: ["warm-up", "warm up", "warmup"],
  cool: ["cool-down", "cool down", "cooldown"],
  main: ["main set", "main"],
};

/** Index of the earliest match of any spelling of `kind`, or -1. */
function findMarker(text: string, kind: "warm" | "cool" | "main"): number {
  const lower = text.toLowerCase();
  let best = -1;
  for (const word of MARKERS[kind]) {
    const i = lower.indexOf(word);
    if (i >= 0 && (best === -1 || i < best)) best = i;
  }
  return best;
}

/** End of the sentence starting at `from` (first ".", "!", or "?"), else EOF. */
function sentenceEnd(text: string, from: number): number {
  const rel = text.slice(from).search(/[.?!]/);
  return rel === -1 ? text.length : from + rel + 1;
}

/** Strip a leading phase marker ("warm-up ", "main set: ") from a body slice. */
function stripMarker(body: string, kind: "warm" | "cool" | "main"): string {
  const out = body.trim();
  for (const word of MARKERS[kind]) {
    if (out.toLowerCase().startsWith(word)) {
      return out.slice(word.length).replace(/^\s*[:.]?\s*/, "").trim();
    }
  }
  return out;
}

/**
 * Splits instructions into ordered phases. Returns [] for empty input.
 * With no recognizable structure the whole text comes back as a single
 * "Core" card, so nothing is ever hidden.
 */
export function segmentPhases(raw: string): Phase[] {
  const text = (raw ?? "").trim();
  if (!text) return [];

  const warmIdx = findMarker(text, "warm");
  const coolIdx = findMarker(text, "cool");
  const mainIdx = findMarker(text, "main");

  // Warm-up card: marker start → end of its sentence. If the "main set"
  // marker appears on the same line as the warm-up marker, cut there instead so
  // the core keeps its opener.
  let warmStart = warmIdx;
  let warmEnd = warmIdx >= 0 ? sentenceEnd(text, warmIdx) : -1;
  if (
    warmIdx >= 0 &&
    mainIdx > warmIdx &&
    mainIdx < sentenceEnd(text, warmIdx)
  ) {
    warmEnd = mainIdx;
  }

  const coolStart = coolIdx;
  const coreStart = warmIdx >= 0 ? warmEnd : 0;
  const coreEnd = coolStart >= 0 ? coolStart : text.length;

  const pieces: Array<{ label: string; start: number; end: number }> = [];
  if (warmIdx >= 0 && warmEnd > warmIdx) {
    pieces.push({ label: "Warm-up", start: warmIdx, end: warmEnd });
  }
  if (coreEnd > coreStart) {
    pieces.push({ label: "Core", start: coreStart, end: coreEnd });
  }
  if (coolStart >= 0 && sentenceEnd(text, coolStart) > coolStart) {
    pieces.push({ label: "Cool-down", start: coolStart, end: sentenceEnd(text, coolStart) });
  }

  // No recognizable structure → the whole text is one core card.
  const normalized = pieces.length
    ? pieces
    : [{ label: "Core", start: 0, end: text.length }];

  return normalized
    .map((p, i) => {
      const kind = p.label === "Warm-up" ? "warm" : p.label === "Cool-down" ? "cool" : "main";
      return { step: i + 1, label: p.label, body: stripMarker(text.slice(p.start, p.end), kind) };
    })
    .filter((p) => p.body.length > 0);
}
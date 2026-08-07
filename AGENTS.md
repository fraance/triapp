<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# TriApp project rules

## 1. Always prefill from data we already have
**Never ask the athlete for something we can already work out.** Before adding any
input field, check every source we hold and pre-populate it:

- Strava athlete profile (`/athlete`): weight, FTP, sex, city/country, gear
- Strava activities: max HR, threshold HR, FTP estimate, CSS, threshold pace,
  weekly volume, personal bests (via official `best_efforts`)
- Uploaded documents (spreadsheets, notes)
- Race research (web search)
- Anything already stored on another record

Rules for prefilling:
- **Blank field** → fill it automatically from the best available source.
- **Conflict** (the athlete's value differs from what we found) → do NOT
  overwrite and do NOT silently ignore it. Raise it as a suggestion and let the
  athlete choose: keep theirs, or accept ours. Their answer is remembered so we
  never nag about the same value twice.
- **Always label the origin** — show whether a value was entered by the athlete,
  read from Strava, or estimated, plus the basis for an estimate.
- A field the athlete leaves blank must simply go unused — never guessed at.
- Manual entry stays available as an override for everything.
- Use a sensible per-field tolerance so trivial differences don't create noise.

## 2. Never invent data
If a value cannot be sourced, leave it null and ask the athlete. Enforce this in
code, not just in prompts — models will fabricate confident-sounding numbers.
See `enforceIdentification()` in `lib/race-profile.ts` for the pattern.

## 3. Tests must never touch real user data
Background jobs and bulk operations must accept a scope (e.g. `userIds`) so tests
can restrict them to throwaway accounts. Always clean up test users afterwards.

## 4. Use the design system — never invent UI
There is one design system, defined in `app/globals.css`. Read its header comment
before writing any markup. The reference points are race kit and instrumentation
— MAAP, Assos, a power meter head unit. Swiss technical minimalism, not
lifestyle wellness. Build with it; do not hand-roll alternatives.

**Typography — two faces, no exceptions:**
- **Inter** is the whole interface. `.display` / `.page-title` /
  `.section-title` for headings — all uppercase, tight tracking, heavy weight.
- **JetBrains Mono** is every number, label, timestamp and status word.
  `.meta` and `.eyebrow` for micro-labels (`0.65rem`, tracked out, uppercase),
  `.numeral` / `.numeral-lg` / `.numeral-sm` for figures (tabular, tight).
- **There is no serif and no italic in this product.** `font-serif` is aliased
  to the grotesque and `em`/`i` are reset to normal weight-600, so neither can
  creep back in. A different speaker is signalled with weight, size and measure
  — see `.agent-voice` for the coach — never with a different face.

**Colour:**
- Stark white canvas, pure black ink, cool neutral greys. No warmth, no beige.
- `--signal` (`#FF3B00`, hi-vis orange) is **reserved**. It marks status tags
  and active metrics only — `.badge-signal`, `.numeral-signal`, meter fills,
  the active nav rule, focus rings. Primary buttons are black. If the accent
  gets spent on ordinary actions it stops meaning anything.
- Colour otherwise comes from the ramps, never a new hex. `indigo-*` is the
  signal ramp (hi-vis at mid, black at the dark end) and `gray-*` is cool
  neutral; both are remapped in `@theme`, so plain Tailwind utilities are
  already on system.

**Geometry:**
- Radii run 0–6px and never further — the scale is capped in `@theme`, so even
  `rounded-3xl` lands on 6px. Nothing is a stadium or a pill.
- Separation is a **1px hairline** (`--hairline`) or a tonal shift. Shadows are
  reserved for things that genuinely float (modals). A card is a ruled box.

**Density & layout:**
- Metrics go in `.metric-grid` (+ `MetricGrid` in `components/ui.tsx`) — dense,
  ruled, column-aligned so figures can be compared down the page. Not a loose
  vertical stack.
- Every scrollable view uses `.page-shell`, which already reserves the fixed
  mobile tab bar plus `env(safe-area-inset-bottom)`. Never let a view clip its
  own last action.

**Reach for the existing class before writing a new one:**
- Surfaces — `.card` (+ `.card-pad`, `.card-invert`, `.card-flag`,
  `.card-signal`), `.well`, `.divider`, `.bar` for chrome.
- Controls — `.btn` + `.btn-primary/secondary/ghost/success/danger/danger-soft`
  (+ `.btn-sm` / `.btn-lg`), `.tag` for suggestion chips and filters.
- Forms — `.label`, `.input`, `.select`, `.textarea`, `.hint`.
- Status — `.badge` + tint, `.alert` + tint, `.meter` for progress.
- Shared components — `PageHeader`, `Stat`, `MetricGrid`, `Loading`,
  `Thinking`, `MetaRow`, `EmptyState` in `components/ui.tsx`.

**Standing requirements:**
- Expose the work. A number the coach derived must show its origin and its
  confidence in the mono register — a figure with no working shown is one the
  athlete can neither trust nor argue with.
- Never leave a bare "no data" line. Use `EmptyState` with one obvious next step.
- Offer `.tag` suggestions rather than a blank input wherever the athlete is
  being asked to say something.
- If a genuinely new pattern is needed, add it to `app/globals.css` as a named
  class so the next page inherits it. Do not scatter one-off utility soup.

## 5. Every milestone must be runnable and tested
Write automated tests for new logic (`npm test`), verify `npm run build` passes,
and give the CEO exact terminal commands plus what he should see.

## 6. Always commit and push
Once a change is tested and `npm run build` passes, commit it and push to `main`
without waiting to be asked each time — Railway auto-deploys from `main`, so
this is how work actually reaches the CEO. Write a clear commit message, but do
not stop to ask for permission to commit/push on top of an already-approved
task.

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

## 4. UI is not a priority
Build functionality, not visual polish. Keep pages plain and consistent with what
already exists.

## 5. Every milestone must be runnable and tested
Write automated tests for new logic (`npm test`), verify `npm run build` passes,
and give the CEO exact terminal commands plus what he should see.

## 6. Always commit and push
Once a change is tested and `npm run build` passes, commit it and push to `main`
without waiting to be asked each time — Railway auto-deploys from `main`, so
this is how work actually reaches the CEO. Write a clear commit message, but do
not stop to ask for permission to commit/push on top of an already-approved
task.

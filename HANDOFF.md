# TriApp — Project Handoff

**Last updated:** 30 July 2026
**Purpose:** everything a new agent needs to pick up work without re-discovery.

---

## 1. What this is

An AI triathlon coaching platform. The founder (France Hémain, referred to as
the CEO) is **non-technical**: he does not read, review or debug code. He judges
progress purely by whether the app works when he uses it.

Source docs in the repo root:
- `TriApp PRD.txt` — product requirements
- `TriApp Technical Design Document V4.txt` — architecture intent
- `AGENTS.md` — **project rules. Read these first, they are binding.**

### The core promise (not yet built)
A plan that **adapts**: weather, fatigue, a heavy session, travel — the plan
reshuffles itself. Today the app *generates* excellent plans but they are
static. This is the single most important remaining gap.

---

## 2. How to run it

```bash
cd /Users/france.hemain/Downloads/triapp
npm run dev            # http://localhost:3000
npm test               # 419 assertions, 9 suites — all passing
npm run build          # must pass before any commit
npm run sync:strava    # pull new Strava activities now
```

Environment lives in `.env.local` (gitignored, never committed).
Required keys: `DATABASE_URL`, `OPENAI_API_KEY`, `STRAVA_CLIENT_ID`,
`STRAVA_CLIENT_SECRET`, `STRAVA_REDIRECT_URI`, `CRON_SECRET`.

---

## 3. Stack

- **Next.js 16** (App Router). ⚠️ Breaking changes vs training data — consult
  `node_modules/next/dist/docs/` before writing framework code.
- **Prisma 7** + PostgreSQL on Railway. v7 requires a **driver adapter**
  (`@prisma/adapter-pg`) and a generated client at `.prisma/client` (gitignored,
  regenerated via `postinstall` and `build`).
- **OpenAI** `gpt-4o-mini`. Uses both `chat.completions` and the **Responses API
  with the `web_search` tool** (live web search works — see `lib/race-profile.ts`).
- Tests: plain `.mts` scripts run with `tsx`. No framework. Each prints
  human-readable checks and exits non-zero on failure.

### Key files
| File | Role |
|---|---|
| `lib/db.ts` | Users, profiles, plans, Today view, season view |
| `lib/plan-dates.ts` | Maps "Week 2, Wednesday" to real calendar dates |
| `lib/ai-coach.ts` | Macrocycle + detailed session generation (batched) |
| `lib/strava.ts` / `lib/strava-db.ts` | OAuth, sync, load estimation |
| `lib/athlete-metrics.ts` | Derives FTP/CSS/HR/thresholds from activity data |
| `lib/athlete-context.ts` | Assembles the full prompt context for the coach |
| `lib/baseline-tests.ts` | Gap analysis → injects FTP/CSS/5k test protocols |
| `lib/race-profile.ts` | Web-search race research + `enforceIdentification()` |
| `lib/personal-bests.ts` | PBs from Strava official `best_efforts` splits |
| `lib/prefill.ts` | Fills blanks; raises conflicts as questions |
| `lib/availability.ts` | **Time available vs physical capacity** |

---

## 4. What works (verified against real data)

- Real accounts, database-backed. Data persists across devices.
- **Strava**: per-user OAuth, 284 activities imported, daily incremental sync,
  de-duplicated. Personalised TSS using the athlete's own HR thresholds.
- **Athlete profile**: auto-derived max HR, FTP, threshold pace, swim CSS,
  personal bests (5k 27:57, 10k 57:19 from official Strava splits). Every value
  labelled measured vs estimated, with its basis.
- **Equipment audit** from data streams — coaching adapts (no watts prescribed
  without a power meter).
- **Baseline tests** injected when a metric is missing *and* the athlete has the
  gear to measure it.
- **Race profiling** via live web search with cited sources. Correctly found
  Triathlon d'Évian (lake swim, mountainous 2000 m bike) from the official site.
- **Plans**: macrocycle covering every week to race day + detailed sessions,
  expandable on demand.
- **Today screen**: today's session, rest days, weekly load, race countdown,
  tomorrow preview, mark complete/skip.
- **Documents**: upload .xlsx/.csv/.txt as coach context.
- **Availability**: per-day hours, or "no time constraints"; plan targets
  whichever of time/capacity is tighter.

---

## 5. What does NOT work

| Thing | Status |
|---|---|
| **Adaptation engine** | **Not built.** The core PRD promise. Next milestone. |
| **Garmin** | Blocked — API application under review. Endpoints return 503. |
| **Google Calendar** | Not built. Endpoints return 503. |
| **Deployment** | Live but **broken** — see §6. |
| Advanced run dynamics (cadence, GCT, SWOLF) | Strava's summary feed doesn't expose these. Needs Garmin or FIT parsing. |

⚠️ Garmin and Calendar previously **faked** a connection and served fabricated
workouts. That was removed. Do not reintroduce mock data that could be mistaken
for real training.

---

## 6. Deployment — CURRENTLY BROKEN (first thing to fix)

- **Live URL:** https://triapp-production.up.railway.app
- **GitHub:** https://github.com/fraance/triapp (main is up to date, 0 unpushed)
- **Builds fine.** Fails at runtime.

**Cause:** all environment variables are missing in Railway.

```
/api/health  →  healthy: false, database: FAILED
missing: DATABASE_URL, OPENAI_API_KEY, STRAVA_CLIENT_ID,
         STRAVA_CLIENT_SECRET, STRAVA_REDIRECT_URI
```

**Fix:** CEO must add 6 variables in Railway → `triapp` service → Variables →
Raw Editor. Command to copy them to clipboard:

```bash
cd /Users/france.hemain/Downloads/triapp && { grep -E "^(DATABASE_URL|OPENAI_API_KEY|STRAVA_CLIENT_ID|STRAVA_CLIENT_SECRET|CRON_SECRET)=" .env.local | sed 's/"//g'; echo "STRAVA_REDIRECT_URI=https://triapp-production.up.railway.app/api/strava/callback"; } | pbcopy
```

Verify with `/api/health` → want `"healthy": true`.

Also: Strava's callback domain is still `localhost`. Changing it to the Railway
domain **breaks local dev** (Strava allows one domain). Consider a second Strava
app for local testing.

---

## 7. ⚠️ Security — outstanding

The CEO pasted live credentials into a chat: **OpenAI API key**, **database
password**, and **Strava client secret**. They have **not been rotated yet**.

Recommend rotating, in priority order:
1. OpenAI key (financial exposure) — platform.openai.com/api-keys
2. Postgres password — Railway → Postgres service → regenerate
3. Strava client secret — strava.com/settings/api

After rotating, update `.env.local` **and** Railway.

Also note: auth is MVP-grade (simple session in localStorage, no CSRF, no rate
limiting). Fine for private testing; **not safe for real users**.

---

## 8. Open data issues on the CEO's account

1. **Run elevation = 0 m** for Évian while the bike is 2000 m. Almost certainly
   wrong; the plan is being built on it.
2. **Availability not set.** Capacity says ~3.6 h/week trained, 14.4 h peak.
   Until he sets it, the coach is correctly told not to assume.

Never guess these — the rules forbid inventing data. Ask, or leave blank.

---

## 9. Working agreement with the CEO

- He will **not** provide personal data in chat. Build the input into the
  product instead — it must work for any user.
- Give **exact copy-paste terminal commands** and say what he should see.
- **UI is not a priority.** Functionality over polish.
- Every milestone must be runnable and tested. `npm test` + `npm run build`.
- Be honest about what doesn't work. He has repeatedly (and correctly) caught
  fabricated data and fake "connected" states. Verify claims before making them.

---

## 10. Suggested next steps

1. **Get the deployment working** (§6) — 10 minutes, unblocks everything.
2. **Rotate credentials** (§7).
3. **Build the adaptation engine** — the core differentiator:
   - Daily check-in ("slept badly, 2 glasses of wine, legs sore")
   - Detect overshoot/undershoot vs plan from synced Strava data
   - Regenerate the coming days within availability + capacity limits
   - Log every change with a reason the athlete can read
   - Rate-limit regenerations (PRD: max 3 manual/day)
4. Then: Google Calendar sync, Garmin when approved.

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
| **Deployment** | Working — see §6. Strava OAuth on the live site still blocked. |
| Advanced run dynamics (cadence, GCT, SWOLF) | Strava's summary feed doesn't expose these. Needs Garmin or FIT parsing. |

⚠️ Garmin and Calendar previously **faked** a connection and served fabricated
workouts. That was removed. Do not reintroduce mock data that could be mistaken
for real training.

---

## 6. Deployment — WORKING

- **Live URL:** https://triapp-production.up.railway.app
- **GitHub:** https://github.com/fraance/triapp
- **Railway project:** `optimistic-achievement` (services: `triapp`, `Postgres`)

Fixed on 30 July 2026: all 6 environment variables were missing in Railway and
have been set via the Railway CLI. `/api/health` now returns `"healthy": true`,
database connected, and every page returns 200.

Managing env vars from the terminal (avoids the Railway web UI):

```bash
railway login                                     # one-time, opens browser
railway link --project optimistic-achievement --service triapp --environment production
railway variables --service triapp                # list
railway variables --service triapp --set "KEY=value"
railway redeploy --service triapp --environment production --yes
curl -s https://triapp-production.up.railway.app/api/health
```

`DATABASE_URL` uses Railway's **public proxy** host, not the internal one. It
works; it is marginally slower. Switching to `${{Postgres.DATABASE_URL}}` would
be an improvement, not a fix.

⚠️ **Strava OAuth does not work on the live site.** Strava allows one callback
domain per app and ours is still `localhost` (needed for local dev). Fix by
creating a **second Strava app** for production. Until then, Strava connect only
works on localhost.

---

## 7. Security — credentials rotated

The CEO once pasted live credentials into a chat: **OpenAI API key**, **database
password**, and **Strava client secret**. **All three were rotated on 30 July
2026** and each old credential was verified dead.

Verified: **no secret has ever been committed to git.** `.env*` has always been
gitignored and the full history is clean. Exposure was limited to the chat.

| Credential | Status |
|---|---|
| OpenAI API key | ✅ Rotated. New key `TriappV1_K3` (`…-U4A`). Old (`…0ksA`) revoked — confirmed HTTP 401 `invalid_api_key`. |
| Postgres password | ✅ Rotated (40-char alphanumeric). Old password confirmed rejected: `password authentication failed`. Data intact. |
| Strava client secret | ✅ Rotated (`…25c13`). Verified by a real token refresh + `/athlete` call, both HTTP 200. No re-authorisation was needed. |

### Rotating a credential — the procedure that works

Secrets must never appear in chat. Instead: the CEO copies the new secret to the
clipboard, the agent reads it with `pbpaste`, validates format, **tests it live
before changing anything**, writes it to `.env.local` and Railway, confirms the
old credential is dead, then clears the clipboard.

⚠️ **Postgres trap:** setting Railway's `POSTGRES_PASSWORD` variable does **not**
change the running database's password — that variable is only read on first
initialisation. You must `ALTER USER postgres WITH PASSWORD '…'` over a live
connection, *then* update all of `POSTGRES_PASSWORD`, `PGPASSWORD`,
`DATABASE_URL`, `DATABASE_PUBLIC_URL` on the Postgres service **and**
`DATABASE_URL` on the `triapp` service. Expect ~90 s of downtime. Use
alphanumeric-only passwords so they need no URL-encoding.

No `psql` on this machine — use the `pg` client already in `node_modules`.

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

1. ~~Get the deployment working~~ — **done** 30 July 2026 (§6).
2. ~~Rotate credentials~~ — **done** 30 July 2026, all three (§7).
3. **Build the adaptation engine** — the core differentiator. The CEO is
   defining the intended behaviour himself; wait for his spec before building.
   Groundwork that is already known to be needed:
   - Daily check-in ("slept badly, 2 glasses of wine, legs sore")
   - Detect overshoot/undershoot vs plan from synced Strava data
   - Regenerate the coming days within availability + capacity limits
   - Log every change with a reason the athlete can read
   - Rate-limit regenerations (PRD: max 3 manual/day)
   No adaptation models exist in `prisma/schema.prisma` yet — this is greenfield.
4. Second Strava app so OAuth works in production (§6).
5. Then: Google Calendar sync, Garmin when approved.

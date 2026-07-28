# TriApp — where we left off (28 Jul 2026)

## Start the app
```
cd /Users/france.hemain/Downloads/triapp
npm run dev
```
Then open **http://localhost:3000** and log in. Leave the Terminal window open.

Other commands:
```
npm test              # 365 automated tests
npm run build         # check it compiles
npm run sync:strava   # pull new Strava activities now
```

## What works
Real accounts and database · 284 Strava activities syncing daily · athlete
profile auto-filled from your data (weight, max HR, FTP, 5k 27:57, 10k 57:19) ·
race confirmed (Triathlon d'Évian, 12 Sep 2026, lake swim, mountainous 2000 m
bike) · 7-week plan, all weeks detailed · Today screen · file uploads · prefill
with conflict questions.

## What doesn't
- **No adaptation engine** — plans are generated once and stay static. This is
  the PRD's core promise and the next milestone.
- **Garmin**: blocked awaiting API approval. Check france.hemain@triapp.org.
- **Google Calendar**: still mock.
- **Not deployed** — localhost only, so the daily sync only runs when the Mac
  is awake.
- **No off-site backup** — commits are local only. `.env.local` holds the
  Strava secret, OpenAI key and database URL, and is deliberately not in git.

## Two data issues worth fixing first
1. **Weekly hours = 20.6** but Strava shows you actually train **4.1 h/week**.
   The plan is sized to 20.6 and will be unrealistic.
2. **Run elevation = 0 m** on a race with a 2000 m bike climb — likely wrong.

Both are editable: Profile → Athlete, and Profile → Race.

## Suggested order tomorrow
1. Fix the two data issues above (2 min)
2. Build the adaptation engine — "slept badly, had wine" reshapes the coming days
3. Push to a private GitHub repo for off-site backup
4. Deploy so the daily job runs reliably

# TriApp

AI triathlon coaching platform.

## Start here

**→ Read [`HANDOFF.md`](./HANDOFF.md)** for the full project state: what works,
what doesn't, current blockers, and next steps.

**→ Read [`AGENTS.md`](./AGENTS.md)** for the binding project rules before
writing any code.

## Run it

```bash
npm install
npm run dev      # http://localhost:3000
npm test         # 419 assertions across 9 suites
npm run build
```

Requires `.env.local` with `DATABASE_URL`, `OPENAI_API_KEY`,
`STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, `STRAVA_REDIRECT_URI`,
`CRON_SECRET`.

## Product docs

- `TriApp PRD.txt`
- `TriApp Technical Design Document V4.txt`

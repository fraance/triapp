// Prisma CLI config.
//
// `.env.local` is the single source of truth for secrets (it is what Next.js
// loads and what the app uses). Prisma's default `dotenv/config` only reads
// `.env`, which meant a second copy of DATABASE_URL had to be kept in sync —
// it silently went stale when the database password was rotated and every
// migration command failed to authenticate. Load `.env.local` explicitly so
// there is only ever one place to change.
import { config } from "dotenv";
import { defineConfig } from "prisma/config";

config({ path: ".env.local", override: true });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env["DATABASE_URL"],
  },
});

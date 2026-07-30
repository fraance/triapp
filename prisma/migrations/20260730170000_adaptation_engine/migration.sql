-- Adaptation engine, phase 1.
-- Additive only: every new column is nullable or has a default, so existing
-- plans and sessions are untouched.

-- 1. Real calendar dates + adaptation metadata on sessions ----------------
ALTER TABLE "PlannedSession" ADD COLUMN "scheduledDate" TIMESTAMP(3);
ALTER TABLE "PlannedSession" ADD COLUMN "isAnchor" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PlannedSession" ADD COLUMN "purpose" TEXT;
ALTER TABLE "PlannedSession" ADD COLUMN "originalDate" TIMESTAMP(3);
ALTER TABLE "PlannedSession" ADD COLUMN "originalTss" INTEGER;
ALTER TABLE "PlannedSession" ADD COLUMN "adaptedAt" TIMESTAMP(3);

CREATE INDEX "PlannedSession_planId_scheduledDate_idx"
  ON "PlannedSession"("planId", "scheduledDate");

-- Backfill scheduledDate from the plan's startDate (Monday of week 1) plus the
-- session's week and weekday, matching lib/plan-dates.ts exactly.
UPDATE "PlannedSession" ps
SET "scheduledDate" = tp."startDate"
    + ((ps."week" - 1) * 7) * INTERVAL '1 day'
    + (CASE lower(trim(ps."day"))
         WHEN 'monday' THEN 0 WHEN 'tuesday' THEN 1 WHEN 'wednesday' THEN 2
         WHEN 'thursday' THEN 3 WHEN 'friday' THEN 4 WHEN 'saturday' THEN 5
         WHEN 'sunday' THEN 6 ELSE 0 END) * INTERVAL '1 day'
FROM "TrainingPlan" tp
WHERE ps."planId" = tp."id"
  AND tp."startDate" IS NOT NULL
  AND ps."scheduledDate" IS NULL;

-- Remember where each session started, so changes are always explainable.
UPDATE "PlannedSession"
SET "originalDate" = "scheduledDate", "originalTss" = "tss"
WHERE "originalDate" IS NULL;

-- 2. Event-sourced plan versions -------------------------------------------
CREATE TABLE "PlanVersion" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlanVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlanVersion_planId_version_key" ON "PlanVersion"("planId", "version");
CREATE INDEX "PlanVersion_planId_createdAt_idx" ON "PlanVersion"("planId", "createdAt");

ALTER TABLE "PlanVersion" ADD CONSTRAINT "PlanVersion_planId_fkey"
  FOREIGN KEY ("planId") REFERENCES "TrainingPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. Append-only adaptation log --------------------------------------------
CREATE TABLE "Adaptation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "versionId" TEXT,
    "trigger" TEXT NOT NULL,
    "cause" JSONB NOT NULL,
    "diff" JSONB NOT NULL,
    "scoreBefore" DOUBLE PRECISION,
    "scoreAfter" DOUBLE PRECISION,
    "inputHash" TEXT,
    "explanation" TEXT,
    "outcome" TEXT NOT NULL DEFAULT 'applied',
    "athleteVerdict" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Adaptation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Adaptation_userId_createdAt_idx" ON "Adaptation"("userId", "createdAt");
CREATE INDEX "Adaptation_planId_createdAt_idx" ON "Adaptation"("planId", "createdAt");

ALTER TABLE "Adaptation" ADD CONSTRAINT "Adaptation_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Adaptation" ADD CONSTRAINT "Adaptation_planId_fkey"
  FOREIGN KEY ("planId") REFERENCES "TrainingPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Adaptation" ADD CONSTRAINT "Adaptation_versionId_fkey"
  FOREIGN KEY ("versionId") REFERENCES "PlanVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

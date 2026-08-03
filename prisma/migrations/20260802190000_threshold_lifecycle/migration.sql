-- Threshold lifecycle: manual baseline -> scheduled test -> automatic update.
-- Additive and nullable, so existing rows are untouched.

-- When each threshold was last established, and how.
ALTER TABLE "AthleteProfile" ADD COLUMN "thresholdsMeasuredAt" JSONB;

-- Fitness tests the engine injects into the plan.
ALTER TABLE "PlannedSession" ADD COLUMN "isTest" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PlannedSession" ADD COLUMN "testKind" TEXT;

CREATE INDEX "PlannedSession_planId_isTest_idx" ON "PlannedSession"("planId", "isTest");

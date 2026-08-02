-- Record activities the athlete did that were never planned.
-- Additive and nullable: existing rows are untouched.
ALTER TABLE "PlannedSession" ADD COLUMN "sourceActivityId" TEXT;

-- One session per source activity, so reconciliation can run repeatedly
-- without creating duplicates. NULLs are not compared in Postgres, so
-- ordinary planned sessions are unaffected.
CREATE UNIQUE INDEX "PlannedSession_planId_sourceActivityId_key"
  ON "PlannedSession"("planId", "sourceActivityId");

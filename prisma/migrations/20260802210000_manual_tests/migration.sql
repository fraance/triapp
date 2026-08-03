-- Tests the athlete has no device for: capture by hand, or skip.
ALTER TABLE "PlannedSession" ADD COLUMN "testMode" TEXT;
ALTER TABLE "AthleteProfile" ADD COLUMN "testPreferences" JSONB;

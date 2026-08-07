-- DropIndex
DROP INDEX "PlannedSession_planId_isTest_idx";

-- AlterTable
ALTER TABLE "PlannedSession" ADD COLUMN     "athleteNote" TEXT;

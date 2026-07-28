-- AlterTable
ALTER TABLE "StravaToken" ADD COLUMN "lastSyncedAt" TIMESTAMP(3),
ADD COLUMN "lastSyncError" TEXT;

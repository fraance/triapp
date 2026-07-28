-- AlterTable
ALTER TABLE "StravaActivity" ADD COLUMN "detailsFetched" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "StravaBestEffort" (
    "id" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "distance" DOUBLE PRECISION NOT NULL,
    "elapsedTime" INTEGER NOT NULL,
    "movingTime" INTEGER,
    "startDate" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StravaBestEffort_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "StravaBestEffort_userId_name_idx" ON "StravaBestEffort"("userId", "name");
CREATE UNIQUE INDEX "StravaBestEffort_activityId_name_key" ON "StravaBestEffort"("activityId", "name");
ALTER TABLE "StravaBestEffort" ADD CONSTRAINT "StravaBestEffort_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "StravaActivity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

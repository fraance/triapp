-- AlterTable: athlete physiological thresholds & per-discipline difficulty
ALTER TABLE "AthleteProfile" ADD COLUMN "maxHeartRate" INTEGER,
ADD COLUMN "thresholdHeartRate" INTEGER,
ADD COLUMN "ftpWatts" INTEGER,
ADD COLUMN "swimDifficulty" DOUBLE PRECISION DEFAULT 1.0,
ADD COLUMN "bikeDifficulty" DOUBLE PRECISION DEFAULT 1.0,
ADD COLUMN "runDifficulty" DOUBLE PRECISION DEFAULT 1.0;

-- AlterTable
ALTER TABLE "TrainingPlan" ADD COLUMN "detailedWeeks" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "PlanWeekOutline" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "week" INTEGER NOT NULL,
    "phase" TEXT NOT NULL,
    "focus" TEXT,
    "targetHours" DOUBLE PRECISION,
    "targetTss" INTEGER,
    "isRaceWeek" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlanWeekOutline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AthleteDocument" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "rowCount" INTEGER,
    "includeInAi" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AthleteDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlanWeekOutline_planId_idx" ON "PlanWeekOutline"("planId");
CREATE UNIQUE INDEX "PlanWeekOutline_planId_week_key" ON "PlanWeekOutline"("planId", "week");
CREATE INDEX "AthleteDocument_userId_idx" ON "AthleteDocument"("userId");

-- AddForeignKey
ALTER TABLE "PlanWeekOutline" ADD CONSTRAINT "PlanWeekOutline_planId_fkey" FOREIGN KEY ("planId") REFERENCES "TrainingPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AthleteDocument" ADD CONSTRAINT "AthleteDocument_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

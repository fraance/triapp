-- CreateTable
CREATE TABLE "TrainingAvailability" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "monHours" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "tueHours" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "wedHours" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "thuHours" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "friHours" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "satHours" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sunHours" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "longSessionDay" TEXT,
    "constraints" TEXT,
    "poolAccess" BOOLEAN NOT NULL DEFAULT true,
    "gymAccess" BOOLEAN NOT NULL DEFAULT true,
    "indoorTrainer" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrainingAvailability_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TrainingAvailability_userId_key" ON "TrainingAvailability"("userId");
ALTER TABLE "TrainingAvailability" ADD CONSTRAINT "TrainingAvailability_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

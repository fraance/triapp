-- What the athlete told the coach, in their own words, and how it was read.
CREATE TABLE "AthleteReport" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rawText" TEXT NOT NULL,
    "parsed" JSONB NOT NULL,
    "fromDate" TIMESTAMP(3) NOT NULL,
    "toDate" TIMESTAMP(3) NOT NULL,
    "reply" TEXT,
    "adaptationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AthleteReport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AthleteReport_userId_createdAt_idx" ON "AthleteReport"("userId", "createdAt");

ALTER TABLE "AthleteReport" ADD CONSTRAINT "AthleteReport_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Judgement calls the engine puts to the athlete.
CREATE TABLE "PlanDecision" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "context" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "facts" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "answer" TEXT,
    "answeredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PlanDecision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlanDecision_userId_kind_key" ON "PlanDecision"("userId", "kind");
CREATE INDEX "PlanDecision_userId_status_idx" ON "PlanDecision"("userId", "status");

ALTER TABLE "PlanDecision" ADD CONSTRAINT "PlanDecision_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- How the athlete wants their plan built.
ALTER TABLE "AthleteProfile" ADD COLUMN "trainingPreferences" JSONB;

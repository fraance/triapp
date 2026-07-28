-- CreateTable
CREATE TABLE "ProfileSuggestion" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "valueType" TEXT NOT NULL DEFAULT 'number',
    "currentValue" TEXT,
    "currentDisplay" TEXT,
    "suggestedValue" TEXT NOT NULL,
    "suggestedDisplay" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProfileSuggestion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProfileSuggestion_userId_field_key" ON "ProfileSuggestion"("userId", "field");
CREATE INDEX "ProfileSuggestion_userId_status_idx" ON "ProfileSuggestion"("userId", "status");
ALTER TABLE "ProfileSuggestion" ADD CONSTRAINT "ProfileSuggestion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

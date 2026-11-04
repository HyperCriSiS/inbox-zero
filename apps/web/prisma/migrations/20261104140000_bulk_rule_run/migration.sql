-- CreateEnum
CREATE TYPE "BulkRuleRunStatus" AS ENUM ('RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED', 'FAILED');

-- CreateTable
CREATE TABLE "BulkRuleRun" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "status" "BulkRuleRunStatus" NOT NULL DEFAULT 'RUNNING',
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "includeRead" BOOLEAN NOT NULL DEFAULT false,
    "rerun" BOOLEAN NOT NULL DEFAULT false,
    "skipDraftReplies" BOOLEAN NOT NULL DEFAULT true,
    "pageToken" TEXT,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "finishedAt" TIMESTAMP(3),
    "emailAccountId" TEXT NOT NULL,

    CONSTRAINT "BulkRuleRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BulkRuleRun_emailAccountId_createdAt_idx" ON "BulkRuleRun"("emailAccountId", "createdAt");

-- AddForeignKey
ALTER TABLE "BulkRuleRun" ADD CONSTRAINT "BulkRuleRun_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

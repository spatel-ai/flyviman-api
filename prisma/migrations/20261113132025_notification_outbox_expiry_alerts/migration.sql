-- CreateEnum
CREATE TYPE "ExpiryDocumentKind" AS ENUM ('OPERATOR', 'AIRCRAFT');

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "nextAttemptAt" TIMESTAMPTZ,
ADD COLUMN     "recipient" TEXT;

-- CreateTable
CREATE TABLE "DocumentExpiryAlert" (
    "id" UUID NOT NULL,
    "kind" "ExpiryDocumentKind" NOT NULL,
    "documentId" UUID NOT NULL,
    "threshold" INTEGER NOT NULL,
    "expiresAt" DATE NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "DocumentExpiryAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DocumentExpiryAlert_documentId_idx" ON "DocumentExpiryAlert"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentExpiryAlert_kind_documentId_threshold_expiresAt_key" ON "DocumentExpiryAlert"("kind", "documentId", "threshold", "expiresAt");

-- CreateIndex
CREATE INDEX "Notification_status_nextAttemptAt_idx" ON "Notification"("status", "nextAttemptAt");

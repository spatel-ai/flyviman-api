-- CreateEnum
CREATE TYPE "PaymentReviewReason" AS ENUM ('BOOKING_CLOSED', 'ALREADY_PAID', 'AMOUNT_MISMATCH');

-- AlterEnum
ALTER TYPE "PaymentProvider" ADD VALUE 'MOCK';

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "reviewReason" "PaymentReviewReason";

-- AlterTable
ALTER TABLE "ServiceCategoryConfig" ADD COLUMN     "depositPercent" INTEGER NOT NULL DEFAULT 25;

-- CreateIndex
CREATE INDEX "Payment_reviewReason_createdAt_idx" ON "Payment"("reviewReason", "createdAt");


-- Hand-written below: Prisma cannot express CHECK constraints.

-- Existing rows take the default (25) from ADD COLUMN ... DEFAULT. A deposit
-- is a real share of the total, never nothing and never more than all of it.
ALTER TABLE "ServiceCategoryConfig"
  ADD CONSTRAINT "ServiceCategoryConfig_deposit_percent_range"
  CHECK ("depositPercent" BETWEEN 1 AND 100);

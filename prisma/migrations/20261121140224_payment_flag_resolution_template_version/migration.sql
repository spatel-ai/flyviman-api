-- AlterTable
ALTER TABLE "NotificationTemplate" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "reviewResolvedAt" TIMESTAMPTZ;

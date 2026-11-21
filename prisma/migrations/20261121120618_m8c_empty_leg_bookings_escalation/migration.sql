-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "BookingEventType" ADD VALUE 'ESCALATED';
ALTER TYPE "BookingEventType" ADD VALUE 'ESCALATION_RESOLVED';
ALTER TYPE "BookingEventType" ADD VALUE 'PASSENGERS_CHANGED';

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "escalatedAt" TIMESTAMPTZ;

-- CreateIndex
CREATE INDEX "Booking_emptyLegId_idx" ON "Booking"("emptyLegId");

-- CreateIndex
CREATE INDEX "Booking_escalatedAt_idx" ON "Booking"("escalatedAt");

-- No code wrote Booking.emptyLegId before this migration; clear any value
-- that names no offer, so the foreign key cannot fail on existing rows.
UPDATE "Booking" AS b
SET "emptyLegId" = NULL
WHERE b."emptyLegId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "EmptyLeg" e WHERE e."id" = b."emptyLegId");

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_emptyLegId_fkey" FOREIGN KEY ("emptyLegId") REFERENCES "EmptyLeg"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One live booking per empty-leg offer (M8-C), the backstop to the offer's
-- row lock in EmptyLegBookingsService. A booking that ended (operator
-- unavailable, quote declined, expired, cancelled) frees the offer again.
-- No rows can break it: nothing set emptyLegId before this migration.
CREATE UNIQUE INDEX "Booking_one_live_per_empty_leg"
  ON "Booking"("emptyLegId")
  WHERE "emptyLegId" IS NOT NULL
    AND "status" NOT IN ('OPERATOR_UNAVAILABLE', 'QUOTE_DECLINED', 'EXPIRED', 'CANCELLED');

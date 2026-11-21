-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "depositPercent" INTEGER;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "smsOptedOut" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "whatsappOptedOut" BOOLEAN NOT NULL DEFAULT false;

-- Backfill (hand-written): existing Model C bookings keep the deposit percent
-- configured now for their category in region IN, or the default of 25 when
-- no row exists (configuration/category-config.ts DEFAULT_DEPOSIT_PERCENT).
UPDATE "Booking" AS b
SET "depositPercent" = COALESCE(
  (SELECT c."depositPercent" FROM "ServiceCategoryConfig" AS c
   WHERE c."category" = b."category" AND c."region" = 'IN'),
  25)
WHERE b."paymentModel" = 'C_DEPOSIT' AND b."depositPercent" IS NULL;

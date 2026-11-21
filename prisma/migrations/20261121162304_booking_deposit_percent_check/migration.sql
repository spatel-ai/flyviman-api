-- Hand-written: Prisma cannot express CHECK constraints.

-- A saved deposit percent is a real share of the total, as on
-- ServiceCategoryConfig: never nothing and never more than all of it. Null
-- for Models A and B. No row can break it (the column was backfilled from
-- ServiceCategoryConfig, which has the same CHECK, or 25); one that did would
-- be cleared here, so the booking reads the configured percent again
-- (bookings/deposit-percent.ts), rather than fail the deploy.
UPDATE "Booking"
SET "depositPercent" = NULL
WHERE "depositPercent" NOT BETWEEN 1 AND 100;

ALTER TABLE "Booking"
  ADD CONSTRAINT "Booking_deposit_percent_range"
  CHECK ("depositPercent" IS NULL OR "depositPercent" BETWEEN 1 AND 100);

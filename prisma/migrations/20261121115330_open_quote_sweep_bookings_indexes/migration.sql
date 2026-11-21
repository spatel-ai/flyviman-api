-- The admin bookings list, newest first with no filter (W5-5).
-- CreateIndex
CREATE INDEX "Booking_createdAt_id_idx" ON "Booking"("createdAt", "id");

-- One open (SENT) quote per booking, as a backstop to the booking lock
-- `QuotesService.issue` holds while it supersedes the open quote and sends
-- the new one. Rows that would break it are fixed first: all but the newest
-- SENT quote of a booking (the order `QuotesService.newest` uses) become
-- SUPERSEDED, as a revision would have made them.
UPDATE "Quote" AS q
SET "status" = 'SUPERSEDED', "updatedAt" = now()
FROM (
  SELECT "id",
         row_number() OVER (
           PARTITION BY "bookingId" ORDER BY "createdAt" DESC, "id" DESC
         ) AS rank
  FROM "Quote"
  WHERE "status" = 'SENT' AND "bookingId" IS NOT NULL
) AS ranked
WHERE q."id" = ranked."id"
  AND ranked.rank > 1;

CREATE UNIQUE INDEX "Quote_one_open_per_booking"
  ON "Quote"("bookingId") WHERE "status" = 'SENT';

-- The payment sweep's lookup of notices stored before their payment was
-- recorded (paymentId null, kept so once applied: the table is append-only),
-- by the order they name. Matches the expression Prisma writes for
-- `payload: { path: ['providerOrderId'], equals }`; the partial predicate is
-- the sweep's own, so only those notices are indexed.
CREATE INDEX "PaymentEvent_early_notice_order_idx"
  ON "PaymentEvent"(("payload" #> '{providerOrderId}'))
  WHERE "paymentId" IS NULL;

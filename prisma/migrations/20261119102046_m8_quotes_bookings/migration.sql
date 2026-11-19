-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('REQUESTED', 'OPERATOR_PENDING', 'CLARIFICATION_REQUESTED', 'PRICE_CONFIRMED', 'AWAITING_PAYMENT', 'CONFIRMED', 'SCHEDULED', 'COMPLETED', 'OPERATOR_UNAVAILABLE', 'QUOTE_DECLINED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BookingPaymentStatus" AS ENUM ('UNPAID', 'PARTIALLY_PAID', 'PAID', 'REFUND_PENDING', 'REFUNDED');

-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "BookingEventType" AS ENUM ('STATUS_CHANGED', 'OPERATOR_RESPONSE', 'QUOTE_ISSUED', 'PAYMENT_UPDATE', 'NOTE', 'MESSAGE', 'CHANGE_REQUESTED', 'CANCELLATION_REQUESTED');

-- CreateEnum
CREATE TYPE "ChangeRequestKind" AS ENUM ('CHANGE', 'CANCELLATION');

-- CreateEnum
CREATE TYPE "ChangeRequestStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'COMPLETED');

-- CreateTable
CREATE TABLE "Quote" (
    "id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "bookingId" UUID,
    "calculationId" UUID,
    "operatorId" UUID NOT NULL,
    "totalMinor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "priceType" "PriceType" NOT NULL DEFAULT 'QUOTE',
    "conditions" JSONB NOT NULL,
    "validUntil" TIMESTAMPTZ NOT NULL,
    "status" "QuoteStatus" NOT NULL DEFAULT 'DRAFT',
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Booking" (
    "id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "customerId" UUID NOT NULL,
    "category" "ServiceCategory" NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'REQUESTED',
    "bookingMode" "BookingMode" NOT NULL,
    "paymentModel" "PaymentModel" NOT NULL,
    "operatorId" UUID,
    "aircraftId" UUID,
    "emptyLegId" UUID,
    "supplier" TEXT,
    "supplierReference" TEXT,
    "itinerary" JSONB NOT NULL,
    "calculationId" UUID,
    "acceptedQuoteId" UUID,
    "totalMinor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "priceType" "PriceType" NOT NULL,
    "paymentStatus" "BookingPaymentStatus" NOT NULL DEFAULT 'UNPAID',
    "cancellationTerms" JSONB NOT NULL,
    "specialRequests" TEXT,
    "assignedToId" UUID,
    "operatorAcceptedAt" TIMESTAMPTZ,
    "confirmedAt" TIMESTAMPTZ,
    "cancelledAt" TIMESTAMPTZ,
    "cancellationReason" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingPassenger" (
    "id" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "passengerId" UUID,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "dateOfBirth" DATE,
    "gender" "Gender" NOT NULL DEFAULT 'UNSPECIFIED',
    "nationality" CHAR(2),
    "documentType" "IdentityDocumentType",
    "documentNumber" TEXT,
    "documentExpiry" DATE,
    "specialAssistance" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "BookingPassenger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingEvent" (
    "id" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "type" "BookingEventType" NOT NULL,
    "fromStatus" "BookingStatus",
    "toStatus" "BookingStatus",
    "actorId" UUID,
    "actorRole" "Role",
    "payload" JSONB,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChangeRequest" (
    "id" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "kind" "ChangeRequestKind" NOT NULL,
    "details" TEXT NOT NULL,
    "chargeMinor" BIGINT,
    "refundMinor" BIGINT,
    "currency" CHAR(3) NOT NULL,
    "status" "ChangeRequestStatus" NOT NULL DEFAULT 'REQUESTED',
    "decidedById" UUID,
    "decidedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "ChangeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Quote_reference_key" ON "Quote"("reference");

-- CreateIndex
CREATE INDEX "Quote_bookingId_status_idx" ON "Quote"("bookingId", "status");

-- CreateIndex
CREATE INDEX "Quote_operatorId_status_idx" ON "Quote"("operatorId", "status");

-- CreateIndex
CREATE INDEX "Quote_calculationId_idx" ON "Quote"("calculationId");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_reference_key" ON "Booking"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_acceptedQuoteId_key" ON "Booking"("acceptedQuoteId");

-- CreateIndex
CREATE INDEX "Booking_customerId_createdAt_idx" ON "Booking"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "Booking_operatorId_status_idx" ON "Booking"("operatorId", "status");

-- CreateIndex
CREATE INDEX "Booking_status_createdAt_idx" ON "Booking"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Booking_aircraftId_idx" ON "Booking"("aircraftId");

-- CreateIndex
CREATE INDEX "Booking_calculationId_idx" ON "Booking"("calculationId");

-- CreateIndex
CREATE INDEX "Booking_assignedToId_idx" ON "Booking"("assignedToId");

-- CreateIndex
CREATE INDEX "BookingPassenger_bookingId_idx" ON "BookingPassenger"("bookingId");

-- CreateIndex
CREATE INDEX "BookingPassenger_passengerId_idx" ON "BookingPassenger"("passengerId");

-- CreateIndex
CREATE INDEX "BookingEvent_bookingId_createdAt_idx" ON "BookingEvent"("bookingId", "createdAt");

-- CreateIndex
CREATE INDEX "ChangeRequest_bookingId_createdAt_idx" ON "ChangeRequest"("bookingId", "createdAt");

-- CreateIndex
CREATE INDEX "ChangeRequest_status_createdAt_idx" ON "ChangeRequest"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_calculationId_fkey" FOREIGN KEY ("calculationId") REFERENCES "PriceCalculation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_aircraftId_fkey" FOREIGN KEY ("aircraftId") REFERENCES "Aircraft"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_calculationId_fkey" FOREIGN KEY ("calculationId") REFERENCES "PriceCalculation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_acceptedQuoteId_fkey" FOREIGN KEY ("acceptedQuoteId") REFERENCES "Quote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingPassenger" ADD CONSTRAINT "BookingPassenger_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingPassenger" ADD CONSTRAINT "BookingPassenger_passengerId_fkey" FOREIGN KEY ("passengerId") REFERENCES "Passenger"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingEvent" ADD CONSTRAINT "BookingEvent_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written below: Prisma cannot express CHECK constraints, partial
-- unique indexes or triggers.

-- Rule 7: air ambulance is never booked instantly (as ServiceCategoryConfig).
ALTER TABLE "Booking"
  ADD CONSTRAINT "Booking_air_ambulance_not_instant"
  CHECK ("category" <> 'AIR_AMBULANCE' OR "bookingMode" <> 'INSTANT');

-- Money is never negative.
ALTER TABLE "Booking"
  ADD CONSTRAINT "Booking_total_not_negative" CHECK ("totalMinor" >= 0);
ALTER TABLE "Quote"
  ADD CONSTRAINT "Quote_total_not_negative" CHECK ("totalMinor" >= 0);
ALTER TABLE "ChangeRequest"
  ADD CONSTRAINT "ChangeRequest_amounts_not_negative"
  CHECK (("chargeMinor" IS NULL OR "chargeMinor" >= 0)
     AND ("refundMinor" IS NULL OR "refundMinor" >= 0));

-- A status change names the status it moved to.
ALTER TABLE "BookingEvent"
  ADD CONSTRAINT "BookingEvent_status_change_has_to_status"
  CHECK ("type" <> 'STATUS_CHANGED' OR "toStatus" IS NOT NULL);

-- Concurrency backstops: one accepted quote per booking, and one open
-- change or cancellation request per booking. New tables, so no rows to fix.
CREATE UNIQUE INDEX "Quote_one_accepted_per_booking"
  ON "Quote"("bookingId") WHERE "status" = 'ACCEPTED';
CREATE UNIQUE INDEX "ChangeRequest_one_open_per_kind"
  ON "ChangeRequest"("bookingId", "kind") WHERE "status" = 'REQUESTED';

-- The booking timeline is append-only, for every database role, like AuditLog.
CREATE FUNCTION "booking_event_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'BookingEvent is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "BookingEvent_append_only"
  BEFORE UPDATE OR DELETE ON "BookingEvent"
  FOR EACH ROW EXECUTE FUNCTION "booking_event_append_only"();

CREATE TRIGGER "BookingEvent_no_truncate"
  BEFORE TRUNCATE ON "BookingEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION "booking_event_append_only"();

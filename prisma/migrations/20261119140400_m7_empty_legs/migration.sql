-- CreateEnum
CREATE TYPE "EmptyLegStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'PUBLISHED', 'BOOKED', 'WITHDRAWN', 'EXPIRED');

-- CreateEnum
CREATE TYPE "EmptyLegPricingBasis" AS ENUM ('OPERATOR_PRICE', 'PLATFORM_CALCULATED');

-- CreateTable
CREATE TABLE "EmptyLeg" (
    "id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "aircraftId" UUID NOT NULL,
    "operatorId" UUID NOT NULL,
    "originId" UUID NOT NULL,
    "destinationId" UUID NOT NULL,
    "currentLocationId" UUID,
    "departureWindowStart" TIMESTAMPTZ NOT NULL,
    "departureWindowEnd" TIMESTAMPTZ NOT NULL,
    "passengerCapacity" INTEGER NOT NULL,
    "priceMinor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "pricingBasis" "EmptyLegPricingBasis" NOT NULL DEFAULT 'OPERATOR_PRICE',
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "bookingDeadline" TIMESTAMPTZ,
    "restrictions" JSONB,
    "bookingConditions" TEXT NOT NULL,
    "status" "EmptyLegStatus" NOT NULL DEFAULT 'DRAFT',
    "submittedAt" TIMESTAMPTZ,
    "publishedAt" TIMESTAMPTZ,
    "reviewedById" UUID,
    "reviewedAt" TIMESTAMPTZ,
    "reviewNote" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "EmptyLeg_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmptyLegInterest" (
    "id" UUID NOT NULL,
    "emptyLegId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "notifiedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "EmptyLegInterest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmptyLeg_reference_key" ON "EmptyLeg"("reference");

-- CreateIndex
CREATE INDEX "EmptyLeg_status_expiresAt_idx" ON "EmptyLeg"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "EmptyLeg_originId_destinationId_departureWindowStart_idx" ON "EmptyLeg"("originId", "destinationId", "departureWindowStart");

-- CreateIndex
CREATE INDEX "EmptyLeg_operatorId_createdAt_idx" ON "EmptyLeg"("operatorId", "createdAt");

-- CreateIndex
CREATE INDEX "EmptyLeg_aircraftId_idx" ON "EmptyLeg"("aircraftId");

-- CreateIndex
CREATE INDEX "EmptyLeg_destinationId_idx" ON "EmptyLeg"("destinationId");

-- CreateIndex
CREATE INDEX "EmptyLeg_currentLocationId_idx" ON "EmptyLeg"("currentLocationId");

-- CreateIndex
CREATE INDEX "EmptyLegInterest_userId_idx" ON "EmptyLegInterest"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "EmptyLegInterest_emptyLegId_userId_key" ON "EmptyLegInterest"("emptyLegId", "userId");

-- AddForeignKey
ALTER TABLE "EmptyLeg" ADD CONSTRAINT "EmptyLeg_aircraftId_fkey" FOREIGN KEY ("aircraftId") REFERENCES "Aircraft"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmptyLeg" ADD CONSTRAINT "EmptyLeg_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmptyLeg" ADD CONSTRAINT "EmptyLeg_originId_fkey" FOREIGN KEY ("originId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmptyLeg" ADD CONSTRAINT "EmptyLeg_destinationId_fkey" FOREIGN KEY ("destinationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmptyLeg" ADD CONSTRAINT "EmptyLeg_currentLocationId_fkey" FOREIGN KEY ("currentLocationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmptyLegInterest" ADD CONSTRAINT "EmptyLegInterest_emptyLegId_fkey" FOREIGN KEY ("emptyLegId") REFERENCES "EmptyLeg"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmptyLegInterest" ADD CONSTRAINT "EmptyLegInterest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Hand-written CHECKs (M7): the window runs forwards, an offer has seats
-- and a price, and it goes somewhere.
ALTER TABLE "EmptyLeg" ADD CONSTRAINT "EmptyLeg_window_forwards" CHECK ("departureWindowEnd" > "departureWindowStart");
ALTER TABLE "EmptyLeg" ADD CONSTRAINT "EmptyLeg_seats_positive" CHECK ("passengerCapacity" > 0);
ALTER TABLE "EmptyLeg" ADD CONSTRAINT "EmptyLeg_price_positive" CHECK ("priceMinor" > 0);
ALTER TABLE "EmptyLeg" ADD CONSTRAINT "EmptyLeg_distinct_ends" CHECK ("originId" <> "destinationId");

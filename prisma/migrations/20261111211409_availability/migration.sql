-- CreateEnum
CREATE TYPE "AvailabilitySlotKind" AS ENUM ('OPEN', 'DEPARTURE_SLOT');

-- CreateEnum
CREATE TYPE "AvailabilityBlockReason" AS ENUM ('MAINTENANCE', 'BLACKOUT', 'SOFT_HOLD', 'BOOKING', 'OTHER');

-- CreateTable
CREATE TABLE "AvailabilitySlot" (
    "id" UUID NOT NULL,
    "aircraftId" UUID NOT NULL,
    "startsAt" TIMESTAMPTZ NOT NULL,
    "endsAt" TIMESTAMPTZ NOT NULL,
    "originId" UUID,
    "kind" "AvailabilitySlotKind" NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "AvailabilitySlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AvailabilityBlock" (
    "id" UUID NOT NULL,
    "aircraftId" UUID NOT NULL,
    "startsAt" TIMESTAMPTZ NOT NULL,
    "endsAt" TIMESTAMPTZ NOT NULL,
    "reason" "AvailabilityBlockReason" NOT NULL,
    "bookingId" UUID,
    "expiresAt" TIMESTAMPTZ,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "AvailabilityBlock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AvailabilitySlot_aircraftId_startsAt_endsAt_idx" ON "AvailabilitySlot"("aircraftId", "startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "AvailabilitySlot_originId_idx" ON "AvailabilitySlot"("originId");

-- CreateIndex
CREATE INDEX "AvailabilityBlock_aircraftId_startsAt_endsAt_idx" ON "AvailabilityBlock"("aircraftId", "startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "AvailabilityBlock_reason_expiresAt_idx" ON "AvailabilityBlock"("reason", "expiresAt");

-- AddForeignKey
ALTER TABLE "AvailabilitySlot" ADD CONSTRAINT "AvailabilitySlot_aircraftId_fkey" FOREIGN KEY ("aircraftId") REFERENCES "Aircraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AvailabilitySlot" ADD CONSTRAINT "AvailabilitySlot_originId_fkey" FOREIGN KEY ("originId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AvailabilityBlock" ADD CONSTRAINT "AvailabilityBlock_aircraftId_fkey" FOREIGN KEY ("aircraftId") REFERENCES "Aircraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Two confirmed booking holds for one aircraft may never overlap.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "AvailabilityBlock"
  ADD CONSTRAINT "AvailabilityBlock_booking_no_overlap"
  EXCLUDE USING gist (
    "aircraftId" WITH =,
    tstzrange("startsAt", "endsAt") WITH &&
  )
  WHERE (reason = 'BOOKING');

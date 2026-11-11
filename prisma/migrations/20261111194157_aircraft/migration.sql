-- CreateEnum
CREATE TYPE "WingType" AS ENUM ('FIXED_WING', 'HELICOPTER');

-- CreateEnum
CREATE TYPE "AircraftAvailabilityStatus" AS ENUM ('AVAILABLE', 'UNAVAILABLE', 'MAINTENANCE');

-- CreateEnum
CREATE TYPE "AircraftListingStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "AircraftPricingModel" AS ENUM ('HOURLY', 'SECTOR', 'FIXED_ROUTE');

-- CreateEnum
CREATE TYPE "AircraftMediaKind" AS ENUM ('PHOTO', 'FLOOR_PLAN');

-- CreateEnum
CREATE TYPE "AircraftDocumentType" AS ENUM ('REGISTRATION', 'AIRWORTHINESS', 'INSURANCE', 'OTHER');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "FilePurpose" ADD VALUE 'AIRCRAFT_PHOTO';
ALTER TYPE "FilePurpose" ADD VALUE 'AIRCRAFT_FLOOR_PLAN';
ALTER TYPE "FilePurpose" ADD VALUE 'AIRCRAFT_DOCUMENT';

-- CreateTable
CREATE TABLE "Aircraft" (
    "id" UUID NOT NULL,
    "operatorId" UUID NOT NULL,
    "registration" TEXT NOT NULL,
    "manufacturer" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "category" "AircraftCategory" NOT NULL,
    "wingType" "WingType" NOT NULL,
    "passengerCapacity" INTEGER NOT NULL,
    "baggageCapacityKg" INTEGER,
    "rangeKm" INTEGER,
    "cruiseSpeedKmh" INTEGER,
    "homeBaseId" UUID,
    "currentLocationId" UUID,
    "operatingRegions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "restrictions" JSONB,
    "availabilityStatus" "AircraftAvailabilityStatus" NOT NULL DEFAULT 'AVAILABLE',
    "listingStatus" "AircraftListingStatus" NOT NULL DEFAULT 'DRAFT',
    "pricingModel" "AircraftPricingModel" NOT NULL DEFAULT 'HOURLY',
    "specifications" JSONB,
    "medicalEquipment" JSONB,
    "submittedAt" TIMESTAMPTZ,
    "reviewedById" UUID,
    "reviewedAt" TIMESTAMPTZ,
    "reviewNote" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "Aircraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AircraftMedia" (
    "id" UUID NOT NULL,
    "aircraftId" UUID NOT NULL,
    "fileId" UUID NOT NULL,
    "kind" "AircraftMediaKind" NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "AircraftMedia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AircraftDocument" (
    "id" UUID NOT NULL,
    "aircraftId" UUID NOT NULL,
    "type" "AircraftDocumentType" NOT NULL,
    "fileId" UUID NOT NULL,
    "issuedAt" DATE,
    "expiresAt" DATE,
    "verificationStatus" "DocumentVerificationStatus" NOT NULL DEFAULT 'PENDING',
    "verifiedById" UUID,
    "verifiedAt" TIMESTAMPTZ,
    "verificationNote" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "AircraftDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Aircraft_registration_key" ON "Aircraft"("registration");

-- CreateIndex
CREATE INDEX "Aircraft_operatorId_listingStatus_idx" ON "Aircraft"("operatorId", "listingStatus");

-- CreateIndex
CREATE INDEX "Aircraft_listingStatus_category_passengerCapacity_idx" ON "Aircraft"("listingStatus", "category", "passengerCapacity");

-- CreateIndex
CREATE INDEX "Aircraft_homeBaseId_idx" ON "Aircraft"("homeBaseId");

-- CreateIndex
CREATE INDEX "Aircraft_currentLocationId_idx" ON "Aircraft"("currentLocationId");

-- CreateIndex
CREATE UNIQUE INDEX "AircraftMedia_fileId_key" ON "AircraftMedia"("fileId");

-- CreateIndex
CREATE INDEX "AircraftMedia_aircraftId_sortOrder_idx" ON "AircraftMedia"("aircraftId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "AircraftDocument_fileId_key" ON "AircraftDocument"("fileId");

-- CreateIndex
CREATE INDEX "AircraftDocument_aircraftId_type_idx" ON "AircraftDocument"("aircraftId", "type");

-- CreateIndex
CREATE INDEX "AircraftDocument_expiresAt_idx" ON "AircraftDocument"("expiresAt");

-- AddForeignKey
ALTER TABLE "Aircraft" ADD CONSTRAINT "Aircraft_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Aircraft" ADD CONSTRAINT "Aircraft_homeBaseId_fkey" FOREIGN KEY ("homeBaseId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Aircraft" ADD CONSTRAINT "Aircraft_currentLocationId_fkey" FOREIGN KEY ("currentLocationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AircraftMedia" ADD CONSTRAINT "AircraftMedia_aircraftId_fkey" FOREIGN KEY ("aircraftId") REFERENCES "Aircraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AircraftDocument" ADD CONSTRAINT "AircraftDocument_aircraftId_fkey" FOREIGN KEY ("aircraftId") REFERENCES "Aircraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

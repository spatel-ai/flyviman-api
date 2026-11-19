-- CreateEnum
CREATE TYPE "BookingMode" AS ENUM ('INSTANT', 'REQUEST');

-- CreateEnum
CREATE TYPE "PaymentModel" AS ENUM ('A_INSTANT', 'B_OPERATOR_CONFIRMED', 'C_DEPOSIT');

-- CreateTable
CREATE TABLE "ServiceCategoryConfig" (
    "id" UUID NOT NULL,
    "category" "ServiceCategory" NOT NULL,
    "region" TEXT NOT NULL DEFAULT 'IN',
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "bookingMode" "BookingMode" NOT NULL,
    "paymentModel" "PaymentModel" NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "ServiceCategoryConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ServiceCategoryConfig_category_region_key" ON "ServiceCategoryConfig"("category", "region");


-- Rule 7: air ambulance is never booked instantly (hand-written).
ALTER TABLE "ServiceCategoryConfig"
  ADD CONSTRAINT "ServiceCategoryConfig_air_ambulance_not_instant"
  CHECK ("category" <> 'AIR_AMBULANCE' OR "bookingMode" <> 'INSTANT');

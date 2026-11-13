-- CreateEnum
CREATE TYPE "PricingRuleScope" AS ENUM ('PLATFORM', 'CATEGORY', 'OPERATOR', 'AIRCRAFT', 'ROUTE');

-- CreateEnum
CREATE TYPE "PricingRuleType" AS ENUM ('HOURLY_RATE', 'SECTOR_RATE', 'FIXED_ROUTE', 'MIN_BILLABLE_HOURS', 'POSITIONING', 'WAITING', 'OVERNIGHT', 'LANDING', 'HANDLING', 'CREW', 'FUEL_SURCHARGE', 'PERMIT', 'NAVIGATION', 'OTHER', 'COMMISSION', 'MARKUP', 'SERVICE_FEE', 'MIN_CHARGE', 'TAX', 'DISCOUNT', 'ROUTING_FACTOR', 'TIME_ALLOWANCE', 'VALIDITY');

-- CreateEnum
CREATE TYPE "PriceType" AS ENUM ('ESTIMATE', 'LIVE_FARE', 'QUOTE', 'CONFIRMED');

-- CreateEnum
CREATE TYPE "TripType" AS ENUM ('ONE_WAY', 'ROUND_TRIP', 'MULTI_LEG');

-- CreateTable
CREATE TABLE "PricingRule" (
    "id" UUID NOT NULL,
    "scope" "PricingRuleScope" NOT NULL,
    "scopeRef" TEXT,
    "type" "PricingRuleType" NOT NULL,
    "config" JSONB NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "validFrom" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validTo" TIMESTAMPTZ,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PricingRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Search" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "category" "ServiceCategory" NOT NULL,
    "tripType" "TripType" NOT NULL,
    "legs" JSONB NOT NULL,
    "passengerCount" INTEGER NOT NULL,
    "preferences" JSONB,
    "results" JSONB NOT NULL,
    "exclusions" JSONB,
    "resultCount" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "providerStatus" JSONB,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Search_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceCalculation" (
    "id" UUID NOT NULL,
    "searchId" UUID,
    "aircraftId" UUID NOT NULL,
    "operatorId" UUID NOT NULL,
    "inputs" JSONB NOT NULL,
    "appliedRules" JSONB NOT NULL,
    "breakdown" JSONB NOT NULL,
    "baseMinor" INTEGER NOT NULL,
    "feesMinor" INTEGER NOT NULL,
    "taxMinor" INTEGER NOT NULL,
    "discountMinor" INTEGER NOT NULL,
    "totalMinor" INTEGER NOT NULL,
    "operatorPayableMinor" INTEGER NOT NULL,
    "platformRevenueMinor" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "priceType" "PriceType" NOT NULL,
    "validUntil" TIMESTAMPTZ NOT NULL,
    "availabilityCheckedAt" TIMESTAMPTZ NOT NULL,
    "assumptions" JSONB NOT NULL,
    "exclusions" JSONB NOT NULL,
    "warnings" JSONB NOT NULL,
    "overriddenById" UUID,
    "overrideReason" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceCalculation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PricingRule_type_scope_scopeRef_isActive_idx" ON "PricingRule"("type", "scope", "scopeRef", "isActive");

-- CreateIndex
CREATE INDEX "Search_createdAt_idx" ON "Search"("createdAt");

-- CreateIndex
CREATE INDEX "PriceCalculation_searchId_idx" ON "PriceCalculation"("searchId");

-- CreateIndex
CREATE INDEX "PriceCalculation_aircraftId_createdAt_idx" ON "PriceCalculation"("aircraftId", "createdAt");

-- AddForeignKey
ALTER TABLE "PriceCalculation" ADD CONSTRAINT "PriceCalculation_searchId_fkey" FOREIGN KEY ("searchId") REFERENCES "Search"("id") ON DELETE SET NULL ON UPDATE CASCADE;

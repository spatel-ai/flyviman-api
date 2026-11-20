-- CreateEnum
CREATE TYPE "PromotionKind" AS ENUM ('PERCENT', 'FIXED');

-- CreateTable
CREATE TABLE "Promotion" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "PromotionKind" NOT NULL,
    "percentBasisPoints" INTEGER,
    "amountMinor" BIGINT,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "category" "ServiceCategory",
    "originId" UUID,
    "destinationId" UUID,
    "startsAt" TIMESTAMPTZ NOT NULL,
    "endsAt" TIMESTAMPTZ NOT NULL,
    "maxUses" INTEGER,
    "maxUsesPerCustomer" INTEGER,
    "endedAt" TIMESTAMPTZ,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "Promotion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromotionRedemption" (
    "id" UUID NOT NULL,
    "promotionId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromotionRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Promotion_code_key" ON "Promotion"("code");

-- CreateIndex
CREATE INDEX "Promotion_createdAt_idx" ON "Promotion"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PromotionRedemption_bookingId_key" ON "PromotionRedemption"("bookingId");

-- CreateIndex
CREATE INDEX "PromotionRedemption_promotionId_customerId_idx" ON "PromotionRedemption"("promotionId", "customerId");

-- AddForeignKey
ALTER TABLE "PromotionRedemption" ADD CONSTRAINT "PromotionRedemption_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "Promotion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Hand-written below: Prisma cannot express CHECK constraints.

-- A percentage or a fixed amount, matching the kind, never both. A percent
-- is more than 0 and at most 100% (10,000 basis points).
ALTER TABLE "Promotion"
  ADD CONSTRAINT "Promotion_value_matches_kind"
  CHECK (
    ("kind" = 'PERCENT' AND "percentBasisPoints" BETWEEN 1 AND 10000 AND "amountMinor" IS NULL)
    OR ("kind" = 'FIXED' AND "amountMinor" > 0 AND "percentBasisPoints" IS NULL)
  );

-- A route is both ends or neither, and two different places.
ALTER TABLE "Promotion"
  ADD CONSTRAINT "Promotion_route_both_ends"
  CHECK (
    ("originId" IS NULL AND "destinationId" IS NULL)
    OR ("originId" IS NOT NULL AND "destinationId" IS NOT NULL AND "originId" <> "destinationId")
  );

ALTER TABLE "Promotion"
  ADD CONSTRAINT "Promotion_window"
  CHECK ("endsAt" > "startsAt");

ALTER TABLE "Promotion"
  ADD CONSTRAINT "Promotion_caps_positive"
  CHECK (("maxUses" IS NULL OR "maxUses" > 0)
     AND ("maxUsesPerCustomer" IS NULL OR "maxUsesPerCustomer" > 0));

-- Codes are stored upper case, so uniqueness is case-insensitive.
ALTER TABLE "Promotion"
  ADD CONSTRAINT "Promotion_code_upper"
  CHECK ("code" = upper("code"));

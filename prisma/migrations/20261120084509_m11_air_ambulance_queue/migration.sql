-- AlterEnum
ALTER TYPE "FilePurpose" ADD VALUE IF NOT EXISTS 'AIR_AMBULANCE_DOCUMENT';

-- AlterTable
ALTER TABLE "AirAmbulanceRequest" ADD COLUMN     "feasibility" JSONB,
ADD COLUMN     "quoteAmountMinor" INTEGER,
ADD COLUMN     "quoteConditions" TEXT,
ADD COLUMN     "quoteCurrency" CHAR(3),
ADD COLUMN     "quotedAt" TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "AirAmbulanceRequestEvent" ADD COLUMN     "payload" JSONB;

-- Hand-written (W4-5).

-- A quotation is whole or absent, in paise, and every status from QUOTED to
-- COMPLETED carries one (rule 1: the customer accepts a labelled price).
ALTER TABLE "AirAmbulanceRequest"
  ADD CONSTRAINT "AirAmbulanceRequest_quote_complete"
  CHECK (
    ("quoteAmountMinor" IS NULL AND "quoteCurrency" IS NULL AND "quotedAt" IS NULL)
    OR ("quoteAmountMinor" > 0 AND "quoteCurrency" IS NOT NULL AND "quotedAt" IS NOT NULL
        AND "selectedOperatorId" IS NOT NULL)
  );

ALTER TABLE "AirAmbulanceRequest"
  ADD CONSTRAINT "AirAmbulanceRequest_quoted_has_quote"
  CHECK ("status" NOT IN ('QUOTED', 'ACCEPTED', 'CONFIRMED', 'COMPLETED')
    OR "quoteAmountMinor" IS NOT NULL);

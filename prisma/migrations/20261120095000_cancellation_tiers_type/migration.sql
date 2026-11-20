-- AlterEnum
-- Flyviman's cancellation tier table (D-172) is a platform pricing rule, so
-- it is versioned, locked and audited like the others. The starting table is
-- inserted by the next migration: PostgreSQL does not let a transaction use
-- an enum value it has just added.
ALTER TYPE "PricingRuleType" ADD VALUE 'CANCELLATION_TIERS';

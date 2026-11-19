-- AlterEnum
ALTER TYPE "PricingRuleType" ADD VALUE 'MATCHING_LIMITS';

-- AlterTable
ALTER TABLE "Operator" ADD COLUMN     "restrictions" JSONB;

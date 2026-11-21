-- W5-8b: a customer's personal data can be erased (DPDP Act). The account row
-- stays, because bookings, payments and audit records refer to it, but it
-- loses every identifier and ends in ERASED. The CHECK that names the new
-- value is in the next migration: PostgreSQL does not let a transaction use
-- an enum value it has just added.

-- AlterEnum
ALTER TYPE "UserStatus" ADD VALUE 'ERASED';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "erasedAt" TIMESTAMPTZ;

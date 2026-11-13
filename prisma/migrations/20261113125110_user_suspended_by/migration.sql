-- CreateEnum
CREATE TYPE "SuspensionSource" AS ENUM ('PLATFORM', 'OPERATOR');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "suspendedBy" "SuspensionSource";

-- Every account suspended before this migration was suspended by Flyviman
-- (operator staff suspension did not exist on `main`), so record it as such.
UPDATE "User" SET "suspendedBy" = 'PLATFORM' WHERE "status" = 'SUSPENDED';

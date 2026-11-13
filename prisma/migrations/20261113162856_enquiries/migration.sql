-- CreateEnum
CREATE TYPE "EnquiryTopic" AS ENUM ('GENERAL', 'PRIVATE_CHARTER', 'CELEBRITY_CHARTER', 'ELECTION_CHARTER', 'MARRIAGE_CHARTER', 'PILGRIMAGE_CHARTER', 'MEDICAL_CHARTER', 'GROUP_CHARTER', 'FLOWER_DROP_CHARTER', 'AIRCRAFT_SALES', 'CONSULTANCY');

-- AlterTable
ALTER TABLE "Notification" ALTER COLUMN "userId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "Enquiry" (
    "id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "topic" "EnquiryTopic" NOT NULL,
    "message" TEXT NOT NULL,
    "handledAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "Enquiry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Enquiry_reference_key" ON "Enquiry"("reference");

-- CreateIndex
CREATE INDEX "Enquiry_handledAt_createdAt_idx" ON "Enquiry"("handledAt", "createdAt");

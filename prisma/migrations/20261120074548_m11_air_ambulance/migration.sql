-- CreateEnum
CREATE TYPE "AirAmbulanceStatus" AS ENUM ('SUBMITTED', 'ASSIGNED', 'SOURCING', 'FEASIBILITY_CHECK', 'QUOTED', 'ACCEPTED', 'CONFIRMED', 'COMPLETED', 'DECLINED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PatientMobility" AS ENUM ('AMBULATORY', 'ASSISTED', 'NON_AMBULATORY');

-- CreateTable
CREATE TABLE "AirAmbulanceRequest" (
    "id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "requesterId" UUID NOT NULL,
    "contactName" TEXT NOT NULL,
    "contactPhone" TEXT NOT NULL,
    "contactEmail" TEXT,
    "emergencyContactName" TEXT,
    "emergencyContactPhone" TEXT,
    "originLocationId" UUID NOT NULL,
    "destinationLocationId" UUID NOT NULL,
    "pickupAddress" TEXT,
    "destinationFacility" TEXT,
    "preferredAt" TIMESTAMPTZ NOT NULL,
    "patientCount" INTEGER NOT NULL DEFAULT 1,
    "accompanyingPersons" INTEGER NOT NULL DEFAULT 0,
    "status" "AirAmbulanceStatus" NOT NULL DEFAULT 'SUBMITTED',
    "assignedToId" UUID,
    "selectedOperatorId" UUID,
    "confirmedAt" TIMESTAMPTZ,
    "completedAt" TIMESTAMPTZ,
    "closedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "AirAmbulanceRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AirAmbulanceMedical" (
    "id" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "patientCondition" TEXT NOT NULL,
    "mobility" "PatientMobility" NOT NULL,
    "stretcherRequired" BOOLEAN NOT NULL DEFAULT false,
    "oxygenRequired" BOOLEAN NOT NULL DEFAULT false,
    "medicalStaffRequired" TEXT,
    "equipmentRequired" TEXT,
    "specialisedCare" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "AirAmbulanceMedical_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AirAmbulanceRequestEvent" (
    "id" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "fromStatus" "AirAmbulanceStatus",
    "toStatus" "AirAmbulanceStatus" NOT NULL,
    "actorId" UUID,
    "actorRole" "Role",
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AirAmbulanceRequestEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AirAmbulanceDocument" (
    "id" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "fileId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "AirAmbulanceDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AirAmbulanceRequest_reference_key" ON "AirAmbulanceRequest"("reference");

-- CreateIndex
CREATE INDEX "AirAmbulanceRequest_requesterId_createdAt_idx" ON "AirAmbulanceRequest"("requesterId", "createdAt");

-- CreateIndex
CREATE INDEX "AirAmbulanceRequest_status_createdAt_idx" ON "AirAmbulanceRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AirAmbulanceRequest_assignedToId_idx" ON "AirAmbulanceRequest"("assignedToId");

-- CreateIndex
CREATE INDEX "AirAmbulanceRequest_selectedOperatorId_status_idx" ON "AirAmbulanceRequest"("selectedOperatorId", "status");

-- CreateIndex
CREATE INDEX "AirAmbulanceRequest_originLocationId_idx" ON "AirAmbulanceRequest"("originLocationId");

-- CreateIndex
CREATE INDEX "AirAmbulanceRequest_destinationLocationId_idx" ON "AirAmbulanceRequest"("destinationLocationId");

-- CreateIndex
CREATE UNIQUE INDEX "AirAmbulanceMedical_requestId_key" ON "AirAmbulanceMedical"("requestId");

-- CreateIndex
CREATE INDEX "AirAmbulanceRequestEvent_requestId_createdAt_idx" ON "AirAmbulanceRequestEvent"("requestId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AirAmbulanceDocument_fileId_key" ON "AirAmbulanceDocument"("fileId");

-- CreateIndex
CREATE INDEX "AirAmbulanceDocument_requestId_createdAt_idx" ON "AirAmbulanceDocument"("requestId", "createdAt");

-- AddForeignKey
ALTER TABLE "AirAmbulanceRequest" ADD CONSTRAINT "AirAmbulanceRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AirAmbulanceRequest" ADD CONSTRAINT "AirAmbulanceRequest_originLocationId_fkey" FOREIGN KEY ("originLocationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AirAmbulanceRequest" ADD CONSTRAINT "AirAmbulanceRequest_destinationLocationId_fkey" FOREIGN KEY ("destinationLocationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AirAmbulanceRequest" ADD CONSTRAINT "AirAmbulanceRequest_selectedOperatorId_fkey" FOREIGN KEY ("selectedOperatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AirAmbulanceMedical" ADD CONSTRAINT "AirAmbulanceMedical_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "AirAmbulanceRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AirAmbulanceRequestEvent" ADD CONSTRAINT "AirAmbulanceRequestEvent_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "AirAmbulanceRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AirAmbulanceDocument" ADD CONSTRAINT "AirAmbulanceDocument_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "AirAmbulanceRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AirAmbulanceDocument" ADD CONSTRAINT "AirAmbulanceDocument_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "StoredFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written (W3-5).

ALTER TABLE "AirAmbulanceRequest"
  ADD CONSTRAINT "AirAmbulanceRequest_counts_valid"
  CHECK ("patientCount" >= 1 AND "accompanyingPersons" >= 0);

-- Rule 7: a request is never confirmed without the time it was confirmed,
-- which only the operations transition sets.
ALTER TABLE "AirAmbulanceRequest"
  ADD CONSTRAINT "AirAmbulanceRequest_confirmed_has_time"
  CHECK ("status" NOT IN ('CONFIRMED', 'COMPLETED') OR "confirmedAt" IS NOT NULL);

-- Rule 7: no automated path leads to CONFIRMED. The timeline entry needs a
-- person from operations or a super administrator as its actor.
ALTER TABLE "AirAmbulanceRequestEvent"
  ADD CONSTRAINT "AirAmbulanceRequestEvent_confirmed_by_person"
  CHECK ("toStatus" <> 'CONFIRMED'
    OR ("actorId" IS NOT NULL AND "actorRole" IS NOT NULL AND "actorRole" IN ('OPS', 'SUPER_ADMIN')));

-- The timeline is append-only for every role, like BookingEvent; `npm run
-- db:grant` derives its revoke list from triggers named *_append_only.
CREATE FUNCTION "air_ambulance_request_event_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AirAmbulanceRequestEvent is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AirAmbulanceRequestEvent_append_only"
  BEFORE UPDATE OR DELETE ON "AirAmbulanceRequestEvent"
  FOR EACH ROW EXECUTE FUNCTION "air_ambulance_request_event_append_only"();

CREATE TRIGGER "AirAmbulanceRequestEvent_no_truncate"
  BEFORE TRUNCATE ON "AirAmbulanceRequestEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION "air_ambulance_request_event_append_only"();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flyviman_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "AirAmbulanceRequestEvent" FROM flyviman_app;
  END IF;
END $$;

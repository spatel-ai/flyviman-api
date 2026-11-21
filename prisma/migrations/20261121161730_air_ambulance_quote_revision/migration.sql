-- A replaced quotation's reason moves out of the append-only timeline into a
-- row that erasure deletes (rule 8). flyviman_app gets SELECT, INSERT, UPDATE
-- and DELETE through the default privileges (20261119130000).
-- CreateTable
CREATE TABLE "AirAmbulanceQuoteRevision" (
    "id" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "AirAmbulanceQuoteRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AirAmbulanceQuoteRevision_eventId_key" ON "AirAmbulanceQuoteRevision"("eventId");

-- CreateIndex
CREATE INDEX "AirAmbulanceQuoteRevision_requestId_idx" ON "AirAmbulanceQuoteRevision"("requestId");

-- AddForeignKey
ALTER TABLE "AirAmbulanceQuoteRevision" ADD CONSTRAINT "AirAmbulanceQuoteRevision_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "AirAmbulanceRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AirAmbulanceQuoteRevision" ADD CONSTRAINT "AirAmbulanceQuoteRevision_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "AirAmbulanceRequestEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

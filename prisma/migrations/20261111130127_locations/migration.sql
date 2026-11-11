-- Trigram matching for location name and city search. Added by hand: Prisma
-- does not manage extensions without a preview feature.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateEnum
CREATE TYPE "LocationType" AS ENUM ('AIRPORT', 'HELIPORT', 'CITY', 'LANDING_SITE');

-- CreateTable
CREATE TABLE "Location" (
    "id" UUID NOT NULL,
    "type" "LocationType" NOT NULL,
    "name" TEXT NOT NULL,
    "iata" CHAR(3),
    "icao" CHAR(4),
    "city" TEXT,
    "state" TEXT,
    "country" CHAR(2) NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "timeZone" TEXT NOT NULL,
    "capabilities" JSONB NOT NULL,
    "charges" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "externalRef" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "Location_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Location_iata_key" ON "Location"("iata");

-- CreateIndex
CREATE UNIQUE INDEX "Location_icao_key" ON "Location"("icao");

-- CreateIndex
CREATE UNIQUE INDEX "Location_externalRef_key" ON "Location"("externalRef");

-- CreateIndex
CREATE INDEX "Location_type_isActive_idx" ON "Location"("type", "isActive");

-- CreateIndex
CREATE INDEX "Location_name_trgm_idx" ON "Location" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Location_city_trgm_idx" ON "Location" USING GIN ("city" gin_trgm_ops);

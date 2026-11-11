import type { Aircraft } from '../../generated/prisma/client.js';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  AircraftDocumentResponseDto,
  AircraftMediaResponseDto,
  AircraftResponseDto,
  AircraftSummaryResponseDto,
} from './dto/aircraft.dto.js';

export type AircraftDocumentRecord =
  Prisma.AircraftDocumentGetPayload<object> & {
    fileName: string;
  };

export type AircraftMediaRecord = Prisma.AircraftMediaGetPayload<object> & {
  fileName: string;
};

export type AircraftDetail = Aircraft & {
  media: AircraftMediaRecord[];
  documents: AircraftDocumentRecord[];
  missing: string[];
};

function asObject(
  value: Prisma.JsonValue | null,
): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function dateOnly(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

export function toMediaDto(row: AircraftMediaRecord): AircraftMediaResponseDto {
  return {
    id: row.id,
    fileId: row.fileId,
    fileName: row.fileName,
    kind: row.kind,
    sortOrder: row.sortOrder,
  };
}

export function toDocumentDto(
  row: AircraftDocumentRecord,
): AircraftDocumentResponseDto {
  return {
    id: row.id,
    type: row.type,
    fileId: row.fileId,
    fileName: row.fileName,
    issuedAt: dateOnly(row.issuedAt),
    expiresAt: dateOnly(row.expiresAt),
    verificationStatus: row.verificationStatus,
  };
}

export function toAircraftDto(row: AircraftDetail): AircraftResponseDto {
  return {
    id: row.id,
    operatorId: row.operatorId,
    registration: row.registration,
    manufacturer: row.manufacturer,
    model: row.model,
    category: row.category,
    wingType: row.wingType,
    passengerCapacity: row.passengerCapacity,
    baggageCapacityKg: row.baggageCapacityKg,
    rangeKm: row.rangeKm,
    cruiseSpeedKmh: row.cruiseSpeedKmh,
    homeBaseId: row.homeBaseId,
    currentLocationId: row.currentLocationId,
    operatingRegions: row.operatingRegions,
    restrictions: asObject(row.restrictions),
    availabilityStatus: row.availabilityStatus,
    listingStatus: row.listingStatus,
    pricingModel: row.pricingModel,
    specifications: asObject(row.specifications),
    medicalEquipment: asObject(row.medicalEquipment),
    submittedAt: row.submittedAt?.toISOString() ?? null,
    reviewNote: row.reviewNote,
    missing: row.missing,
    media: row.media.map(toMediaDto),
    documents: row.documents.map(toDocumentDto),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toSummaryDto(row: Aircraft): AircraftSummaryResponseDto {
  return {
    id: row.id,
    registration: row.registration,
    manufacturer: row.manufacturer,
    model: row.model,
    category: row.category,
    passengerCapacity: row.passengerCapacity,
    availabilityStatus: row.availabilityStatus,
    listingStatus: row.listingStatus,
    homeBaseId: row.homeBaseId,
  };
}

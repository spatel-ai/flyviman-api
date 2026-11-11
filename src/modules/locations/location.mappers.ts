import type {
  AdminLocationResponseDto,
  CreateLocationDto,
  LocationCapabilitiesInputDto,
  LocationChargesDto,
  UpdateLocationDto,
} from './dto/admin-location.dto.js';
import type { LocationResponseDto } from './dto/location.dto.js';
import type {
  AdminLocation,
  LocationCapabilities,
  LocationCharges,
  LocationInput,
  PublicLocation,
} from './locations.service.js';

function capabilitiesInput(
  dto: LocationCapabilitiesInputDto,
): LocationCapabilities {
  return {
    runwayLengthM: dto.runwayLengthM ?? null,
    nightOperations: dto.nightOperations ?? null,
    helicopterApproved: dto.helicopterApproved,
  };
}

function chargesInput(
  dto: LocationChargesDto | null | undefined,
): LocationCharges | null | undefined {
  if (!dto) return dto;
  return {
    currency: dto.currency,
    categories: dto.categories.map((charge) => ({
      category: charge.category,
      landingMinor: charge.landingMinor,
      parkingMinor: charge.parkingMinor,
      handlingMinor: charge.handlingMinor,
    })),
  };
}

export function createInput(dto: CreateLocationDto): LocationInput {
  return {
    type: dto.type,
    name: dto.name,
    iata: dto.iata ?? null,
    icao: dto.icao ?? null,
    city: dto.city ?? null,
    state: dto.state ?? null,
    country: dto.country,
    latitude: dto.latitude,
    longitude: dto.longitude,
    timeZone: dto.timeZone,
    capabilities: capabilitiesInput(dto.capabilities),
    charges: chargesInput(dto.charges) ?? null,
    isActive: true,
  };
}

/** Only the fields the caller sent; `undefined` means leave alone. */
export function updateInput(dto: UpdateLocationDto): Partial<LocationInput> {
  return {
    type: dto.type,
    name: dto.name,
    iata: dto.iata,
    icao: dto.icao,
    city: dto.city,
    state: dto.state,
    country: dto.country,
    latitude: dto.latitude,
    longitude: dto.longitude,
    timeZone: dto.timeZone,
    capabilities: dto.capabilities
      ? capabilitiesInput(dto.capabilities)
      : undefined,
    charges: chargesInput(dto.charges),
    isActive: dto.isActive,
  };
}

export function toAdminLocationDto(
  location: AdminLocation,
): AdminLocationResponseDto {
  return Object.assign(toLocationDto(location), {
    charges: chargesInput(location.charges) ?? null,
    isActive: location.isActive,
    externalRef: location.externalRef,
    createdAt: location.createdAt.toISOString(),
    updatedAt: location.updatedAt.toISOString(),
  });
}

export function toLocationDto(location: PublicLocation): LocationResponseDto {
  return {
    id: location.id,
    type: location.type,
    name: location.name,
    iata: location.iata,
    icao: location.icao,
    city: location.city,
    state: location.state,
    country: location.country,
    latitude: location.latitude,
    longitude: location.longitude,
    timeZone: location.timeZone,
    capabilities: {
      runwayLengthM: location.capabilities.runwayLengthM,
      nightOperations: location.capabilities.nightOperations,
      helicopterApproved: location.capabilities.helicopterApproved,
    },
  };
}

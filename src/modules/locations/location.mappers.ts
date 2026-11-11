import type { LocationResponseDto } from './dto/location.dto.js';
import type { PublicLocation } from './locations.service.js';

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

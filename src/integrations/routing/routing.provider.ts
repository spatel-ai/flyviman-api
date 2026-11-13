/**
 * Distance between two points (pricing-engine.md, step 2). The default is
 * the great-circle distance; an aviation routing provider can replace it
 * without changing anything downstream. The engine applies the category's
 * `ROUTING_FACTOR` on top.
 */
export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export abstract class RoutingProvider {
  abstract distanceKm(from: GeoPoint, to: GeoPoint): number;
}

const EARTH_RADIUS_KM = 6371.0088;

export class GreatCircleRoutingProvider extends RoutingProvider {
  distanceKm(from: GeoPoint, to: GeoPoint): number {
    const rad = (degrees: number) => (degrees * Math.PI) / 180;
    const dLat = rad(to.latitude - from.latitude);
    const dLon = rad(to.longitude - from.longitude);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(rad(from.latitude)) *
        Math.cos(rad(to.latitude)) *
        Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
  }
}

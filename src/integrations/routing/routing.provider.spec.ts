import { describe, expect, it } from 'vitest';
import { GreatCircleRoutingProvider } from './routing.provider.js';

describe('GreatCircleRoutingProvider', () => {
  const routing = new GreatCircleRoutingProvider();

  it('measures Mumbai to Delhi as about 1,150 km', () => {
    const km = routing.distanceKm(
      { latitude: 19.0887, longitude: 72.8679 },
      { latitude: 28.5562, longitude: 77.1 },
    );
    expect(km).toBeGreaterThan(1130);
    expect(km).toBeLessThan(1160);
  });

  it('is zero for the same point', () => {
    const point = { latitude: 15.38, longitude: 73.83 };
    expect(routing.distanceKm(point, point)).toBe(0);
  });
});

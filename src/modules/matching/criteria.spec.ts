import { describe, expect, it } from 'vitest';
import { staticChecks } from './criteria.js';

const now = new Date('2026-12-01T00:00:00Z');
const eligible = {
  passengerCapacity: 8,
  passengerCount: 4,
  rangeKm: 3000,
  distanceKm: 1000,
  positioningMinutes: 60,
  departureAt: new Date('2026-12-01T06:00:00Z'),
  now,
};

describe('staticChecks', () => {
  it('passes an otherwise eligible aircraft', () => {
    expect(staticChecks(eligible)).toEqual([]);
  });

  it('excludes for too few seats', () => {
    expect(staticChecks({ ...eligible, passengerCount: 9 })).toEqual([
      'capacity',
    ]);
  });

  it('excludes when range does not cover the leg with the reserve', () => {
    expect(staticChecks({ ...eligible, rangeKm: 1050 })).toEqual(['range']);
    expect(staticChecks({ ...eligible, rangeKm: null })).toEqual(['range']);
  });

  it('excludes when it cannot reach the origin before departure', () => {
    expect(staticChecks({ ...eligible, positioningMinutes: 400 })).toEqual([
      'positioning',
    ]);
  });
});

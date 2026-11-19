import { describe, expect, it } from 'vitest';
import type { Aircraft } from '../../generated/prisma/client.js';
import { combineRestrictions, type MatchPoint } from './criteria.js';
import { MatchingService, type PreparedRoute } from './matching.service.js';

/** `evaluate` reads no database, so the service needs no dependencies here. */
const service = new MatchingService(
  null as never,
  null as never,
  null as never,
  null as never,
  null as never,
);

const point = (
  id: string,
  nightOperations: boolean | null,
): MatchPoint & {
  latitude: number;
  longitude: number;
  charges: unknown;
} => ({
  id,
  name: `Airport ${id}`,
  type: 'AIRPORT',
  timeZone: 'Asia/Kolkata',
  capabilities: { runwayLengthM: 2500, nightOperations },
  latitude: 0,
  longitude: 0,
  charges: null,
});

/** One aircraft that passes everything else, with a 90-minute leg. */
function prepared(input: {
  destinationNight?: boolean | null;
  operatingHours?: { start: string; end: string };
}): PreparedRoute {
  const origin = point('origin', true);
  const destination = point(
    'destination',
    input.destinationNight === undefined ? true : input.destinationNight,
  );
  return {
    route: {
      categories: ['LIGHT_JET'],
      origin,
      destination,
      passengerCount: 2,
      rules: [],
    },
    excluded: [],
    ready: [
      {
        aircraft: {
          id: 'aircraft-1',
          passengerCapacity: 6,
        } as unknown as Aircraft,
        operatorName: 'Operator',
        base: null,
        rules: {} as never,
        legMinutes: 90,
        positioningMinutes: 0,
        warnings: [],
        rangeKm: 3000,
        distanceKm: 500,
        limits: {},
        restrictions: combineRestrictions(
          input.operatingHours
            ? { operatingHours: input.operatingHours }
            : null,
        ),
        windows: {
          slots: [
            {
              startsAt: new Date('2026-12-04T00:00:00Z'),
              endsAt: new Date('2026-12-07T00:00:00Z'),
              kind: 'OPEN',
              originId: null,
            },
          ],
          blocks: [],
        },
      },
    ],
  };
}

const now = new Date('2026-12-01T00:00:00Z');
/** 11:30 in India; lands 13:00. */
const departureAt = new Date('2026-12-05T06:00:00Z');

describe('MatchingService.evaluate, round trip return leg', () => {
  it('passes a return inside hours and by day', () => {
    // Back at 16:30 India time, landing 18:00.
    const returnAt = new Date('2026-12-05T11:00:00Z');
    const result = service.evaluate(
      prepared({
        destinationNight: false,
        operatingHours: { start: '08:00', end: '18:30' },
      }),
      departureAt,
      now,
      returnAt,
    );
    expect(result.exclusions).toEqual([]);
    expect(result.candidates).toHaveLength(1);
  });

  it('(9) excludes a return that lands outside operating hours', () => {
    // Leaves 17:30 India time, lands at the origin 19:00, after 18:30.
    const returnAt = new Date('2026-12-05T12:00:00Z');
    const result = service.evaluate(
      prepared({ operatingHours: { start: '08:00', end: '18:30' } }),
      departureAt,
      now,
      returnAt,
    );
    expect(result.candidates).toEqual([]);
    expect(result.exclusions).toEqual([
      { aircraftId: 'aircraft-1', reasons: ['operatingHours'] },
    ]);
  });

  it('(5) excludes a night return from a destination without night operations', () => {
    // Leaves the destination at 21:30 India time.
    const returnAt = new Date('2026-12-05T16:00:00Z');
    const result = service.evaluate(
      prepared({ destinationNight: false }),
      departureAt,
      now,
      returnAt,
    );
    expect(result.exclusions).toEqual([
      { aircraftId: 'aircraft-1', reasons: ['nightOperations'] },
    ]);
  });

  it('warns once when night operations are unknown at the destination on both legs', () => {
    // Outbound lands 20:30; return leaves 23:30 the same night.
    const result = service.evaluate(
      prepared({ destinationNight: null }),
      new Date('2026-12-05T13:30:00Z'),
      now,
      new Date('2026-12-05T18:00:00Z'),
    );
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].warnings).toHaveLength(1);
  });
});

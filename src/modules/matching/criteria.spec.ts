import { describe, expect, it } from 'vitest';
import type { RuleRow } from '../pricing/rules.js';
import {
  combineRestrictions,
  landingSiteWarning,
  limitsFor,
  localMinutes,
  nightWarning,
  parseCapabilities,
  routeChecks,
  staticChecks,
  tripLimitIssue,
  timeChecks,
  windowFree,
  type MatchPoint,
} from './criteria.js';

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

describe('windowFree', () => {
  const at = (hour: number) => new Date(Date.UTC(2026, 11, 5, hour));
  const open = {
    startsAt: at(0),
    endsAt: at(23),
    kind: 'OPEN' as const,
    originId: null,
  };

  it('needs offered time covering the whole window', () => {
    expect(windowFree({ slots: [open], blocks: [] }, at(4), at(6), 'A')).toBe(
      true,
    );
    expect(windowFree({ slots: [], blocks: [] }, at(4), at(6), 'A')).toBe(
      false,
    );
    expect(windowFree(undefined, at(4), at(6), 'A')).toBe(false);
  });

  it('a block anywhere in the window rules it out', () => {
    const block = { startsAt: at(5), endsAt: at(8) };
    expect(
      windowFree({ slots: [open], blocks: [block] }, at(4), at(6), 'A'),
    ).toBe(false);
    expect(
      windowFree({ slots: [open], blocks: [block] }, at(9), at(10), 'A'),
    ).toBe(true);
  });

  it('a departure slot counts only from its own origin', () => {
    const departure = {
      ...open,
      kind: 'DEPARTURE_SLOT' as const,
      originId: 'A',
    };
    expect(
      windowFree({ slots: [departure], blocks: [] }, at(4), at(6), 'A'),
    ).toBe(true);
    expect(
      windowFree({ slots: [departure], blocks: [] }, at(4), at(6), 'B'),
    ).toBe(false);
  });
});

// --- M5 slice 4a: one test per criterion, each against an eligible baseline.

const airport = (id: string, capabilities: object = {}): MatchPoint => ({
  id,
  name: `Airport ${id}`,
  type: 'AIRPORT',
  timeZone: 'Asia/Kolkata',
  capabilities: {
    runwayLengthM: 2500,
    nightOperations: true,
    helicopterApproved: true,
    ...capabilities,
  },
});
const ORIGIN = airport('a0000000-0000-4000-8000-000000000001');
const DEST = airport('a0000000-0000-4000-8000-000000000002');
const none = combineRestrictions();
const route = {
  wingType: 'FIXED_WING' as const,
  distanceKm: 500,
  origin: ORIGIN,
  destination: DEST,
  limits: {},
  restrictions: none,
};
/** 11:30 departure and 13:00 arrival in India. */
const timing = {
  departureAt: new Date('2026-12-05T06:00:00Z'),
  arrivalAt: new Date('2026-12-05T07:30:00Z'),
  now: new Date('2026-12-01T00:00:00Z'),
  origin: ORIGIN,
  destination: DEST,
  limits: {},
  restrictions: none,
};
const rule = (
  scope: RuleRow['scope'],
  scopeRef: string | null,
  config: object,
): RuleRow => ({
  id: `${scope}-${scopeRef}`,
  scope,
  scopeRef,
  type: 'MATCHING_LIMITS',
  config,
  priority: 0,
  version: 1,
});

describe('routeChecks', () => {
  it('passes an otherwise eligible aircraft', () => {
    expect(routeChecks(route)).toEqual({ reasons: [], warnings: [] });
    expect(routeChecks({ ...route, wingType: 'HELICOPTER' })).toEqual({
      reasons: [],
      warnings: [],
    });
  });

  it('(3) excludes a leg outside the category distance limits', () => {
    expect(
      routeChecks({ ...route, limits: { maxLegKm: 400 } }).reasons,
    ).toEqual(['distance']);
    expect(
      routeChecks({ ...route, limits: { minLegKm: 600 } }).reasons,
    ).toEqual(['distance']);
  });

  it('(5) excludes a runway shorter than the limit, or unknown', () => {
    const limits = { minRunwayM: 3000 };
    expect(routeChecks({ ...route, limits }).reasons).toEqual(['runway']);
    expect(
      routeChecks({
        ...route,
        limits: { minRunwayM: 1000 },
        destination: airport(DEST.id, { runwayLengthM: null }),
      }).reasons,
    ).toEqual(['runway']);
  });

  it('(5) excludes a fixed-wing aircraft at a heliport', () => {
    expect(
      routeChecks({ ...route, destination: { ...DEST, type: 'HELIPORT' } })
        .reasons,
    ).toEqual(['runway']);
  });

  it('(5) excludes a helicopter where helicopters are not approved, or it is unknown', () => {
    const heli = { ...route, wingType: 'HELICOPTER' as const };
    expect(
      routeChecks({
        ...heli,
        destination: airport(DEST.id, { helicopterApproved: false }),
      }).reasons,
    ).toEqual(['helicopterApproval']);
    expect(
      routeChecks({ ...heli, origin: { ...ORIGIN, capabilities: null } })
        .reasons,
    ).toEqual(['helicopterApproval']);
  });

  it('(6) excludes landing sites where the category limit forbids them, else warns', () => {
    const site: MatchPoint = { ...DEST, type: 'LANDING_SITE' };
    const heli = {
      ...route,
      wingType: 'HELICOPTER' as const,
      destination: site,
    };
    expect(
      routeChecks({ ...heli, limits: { landingSites: 'NOT_ALLOWED' } }).reasons,
    ).toEqual(['landingSite']);
    expect(routeChecks(heli)).toEqual({
      reasons: [],
      warnings: [landingSiteWarning(site.name)],
    });
  });

  it('(7) excludes a location the operator or the aircraft excludes', () => {
    expect(
      routeChecks({
        ...route,
        restrictions: combineRestrictions(
          { excludedLocationIds: [DEST.id] },
          null,
        ),
      }).reasons,
    ).toEqual(['excludedLocation']);
  });
});

describe('timeChecks', () => {
  it('passes an otherwise eligible aircraft', () => {
    expect(timeChecks(timing)).toEqual({ reasons: [], warnings: [] });
  });

  it('(7) excludes a departure inside the minimum notice', () => {
    expect(
      timeChecks({
        ...timing,
        restrictions: combineRestrictions({ minimumNoticeMinutes: 10_080 }),
      }).reasons,
    ).toEqual(['notice']);
  });

  it('(10) excludes a departure inside the category notice', () => {
    expect(
      timeChecks({ ...timing, limits: { minimumNoticeMinutes: 10_080 } })
        .reasons,
    ).toEqual(['notice']);
  });

  it('(9) excludes an arrival outside operating hours at the destination', () => {
    // Departs 11:30 (inside), lands 13:00 (outside 06:00-12:00).
    expect(
      timeChecks({
        ...timing,
        restrictions: combineRestrictions({
          operatingHours: { start: '06:00', end: '12:00' },
        }),
      }).reasons,
    ).toEqual(['operatingHours']);
  });

  it('(9) reads a window that spans midnight', () => {
    const overnight = combineRestrictions({
      operatingHours: { start: '22:00', end: '14:00' },
    });
    expect(timeChecks({ ...timing, restrictions: overnight }).reasons).toEqual(
      [],
    );
    const evening = combineRestrictions({
      operatingHours: { start: '20:00', end: '12:00' },
    });
    expect(timeChecks({ ...timing, restrictions: evening }).reasons).toEqual([
      'operatingHours',
    ]);
  });

  it('(9) excludes when a time zone is unknown and hours are set', () => {
    expect(
      timeChecks({
        ...timing,
        origin: { ...ORIGIN, timeZone: 'Not/AZone' },
        restrictions: combineRestrictions({
          operatingHours: { start: '00:00', end: '23:59' },
        }),
      }).reasons,
    ).toEqual(['operatingHours']);
  });

  it('(5) excludes night arrival where night operations are refused, warns where unknown', () => {
    // Lands 20:30 in India.
    const night = { ...timing, arrivalAt: new Date('2026-12-05T15:00:00Z') };
    expect(
      timeChecks({
        ...night,
        destination: airport(DEST.id, { nightOperations: false }),
      }).reasons,
    ).toEqual(['nightOperations']);
    const unknown = airport(DEST.id, { nightOperations: null });
    expect(timeChecks({ ...night, destination: unknown })).toEqual({
      reasons: [],
      warnings: [nightWarning(unknown.name)],
    });
    // By day the airport's night operations do not matter.
    expect(
      timeChecks({
        ...timing,
        destination: airport(DEST.id, { nightOperations: false }),
      }).reasons,
    ).toEqual([]);
  });
});

describe('combineRestrictions', () => {
  it('keeps the stricter of operator and aircraft', () => {
    const combined = combineRestrictions(
      {
        operatingHours: { start: '06:00', end: '20:00' },
        excludedLocationIds: ['x'],
        minimumNoticeMinutes: 120,
      },
      {
        operatingHours: { start: '08:00', end: '22:00' },
        excludedLocationIds: ['y'],
        minimumNoticeMinutes: 60,
      },
    );
    expect(combined.minimumNoticeMinutes).toBe(120);
    expect([...combined.excludedLocationIds]).toEqual(['x', 'y']);
    expect(combined.operatingHours).toHaveLength(2);
    // 07:00 in India is inside the operator's hours, outside the aircraft's.
    expect(
      timeChecks({
        ...timing,
        departureAt: new Date('2026-12-05T01:30:00Z'),
        arrivalAt: new Date('2026-12-05T03:00:00Z'),
        restrictions: combined,
      }).reasons,
    ).toEqual(['operatingHours']);
  });
});

describe('limitsFor', () => {
  it('applies platform and category limits together, stricter winning', () => {
    const rules = [
      rule('PLATFORM', null, { maxLegKm: 3000, minRunwayM: 1200 }),
      rule('CATEGORY', 'HELICOPTER', {
        maxLegKm: 600,
        landingSites: 'NOT_ALLOWED',
      }),
      rule('CATEGORY', 'LIGHT_JET', { maxLegKm: 2000, minRunwayM: 1000 }),
      rule('OPERATOR', 'op', { maxLegKm: 1 }),
    ];
    expect(limitsFor(rules, 'LIGHT_JET')).toEqual({
      maxLegKm: 2000,
      minRunwayM: 1200,
    });
    expect(limitsFor(rules, 'HELICOPTER')).toEqual({
      maxLegKm: 600,
      minRunwayM: 1200,
      landingSites: 'NOT_ALLOWED',
    });
  });

  it('(10) a platform limit alone excludes an otherwise-eligible aircraft', () => {
    const limits = limitsFor(
      [rule('PLATFORM', null, { minRunwayM: 3000 })],
      'LIGHT_JET',
    );
    expect(routeChecks({ ...route, limits }).reasons).toEqual(['runway']);
    expect(routeChecks(route).reasons).toEqual([]);
  });

  it('ignores malformed configuration', () => {
    expect(
      limitsFor(
        [rule('PLATFORM', null, { maxLegKm: 'far', x: 1 })],
        'LIGHT_JET',
      ),
    ).toEqual({});
  });
});

describe('location data', () => {
  it('reads malformed capabilities as unknown and not approved', () => {
    expect(parseCapabilities('junk')).toEqual({
      runwayLengthM: null,
      nightOperations: null,
      helicopterApproved: false,
    });
  });

  it('gives local minutes, or null for an unknown zone', () => {
    expect(localMinutes(new Date('2026-12-05T06:00:00Z'), 'Asia/Kolkata')).toBe(
      690,
    );
    expect(localMinutes(new Date(), 'Nope/Nowhere')).toBeNull();
  });
});

describe('tripLimitIssue', () => {
  const trip = {
    categories: ['LIGHT_JET' as const],
    distanceKm: () => 500,
    departureAt: timing.departureAt,
    now: timing.now,
  };

  it('passes a trip within every limit', () => {
    expect(
      tripLimitIssue({
        ...trip,
        rules: [rule('PLATFORM', null, { maxLegKm: 1000 })],
      }),
    ).toBeNull();
  });

  it('refuses a departure inside the platform or category notice', () => {
    expect(
      tripLimitIssue({
        ...trip,
        rules: [
          rule('CATEGORY', 'LIGHT_JET', { minimumNoticeMinutes: 10_080 }),
        ],
      }),
    ).toEqual({
      field: 'departureAt',
      issue: 'must be at least 168 hours from now for this trip',
    });
  });

  it('refuses a leg outside the distance limits', () => {
    expect(
      tripLimitIssue({
        ...trip,
        rules: [rule('PLATFORM', null, { maxLegKm: 400 })],
      })?.field,
    ).toBe('destinationId');
    expect(
      tripLimitIssue({
        ...trip,
        rules: [rule('CATEGORY', 'LIGHT_JET', { minLegKm: 600 })],
      })?.field,
    ).toBe('destinationId');
  });

  it('keeps a search where another category can fly the trip', () => {
    expect(
      tripLimitIssue({
        ...trip,
        categories: ['LIGHT_JET', 'HEAVY_JET'],
        rules: [rule('CATEGORY', 'HEAVY_JET', { maxLegKm: 100 })],
      }),
    ).toBeNull();
  });
});

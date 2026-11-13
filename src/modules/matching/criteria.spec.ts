import { describe, expect, it } from 'vitest';
import { staticChecks, windowFree } from './criteria.js';

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

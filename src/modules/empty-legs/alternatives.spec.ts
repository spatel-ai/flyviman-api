import { describe, expect, it } from 'vitest';
import {
  ALTERNATIVE_LIMIT,
  ALTERNATIVE_WINDOW_DAYS,
  isNearby,
  pickAlternatives,
} from './empty-leg-rules.js';

const DAY = 86_400_000;
const mumbai = { id: 'bom', latitude: 19.09, longitude: 72.87 };
const pune = { id: 'pnq', latitude: 18.58, longitude: 73.92 }; // ~120 km
const thane = { id: 'thane', latitude: 19.2, longitude: 72.97 }; // ~15 km
const goa = { id: 'goi', latitude: 15.38, longitude: 73.83 };
const at = new Date('2026-12-10T06:00:00Z');
const trip = {
  origin: mumbai,
  destination: goa,
  departureAt: at,
  passengers: 3,
  now: new Date(at.getTime() - 7 * DAY),
};

function offer(
  over: Partial<{
    origin: typeof mumbai;
    destination: typeof mumbai;
    daysFromRequest: number;
    seats: number;
  }> = {},
) {
  const start = new Date(at.getTime() + (over.daysFromRequest ?? 0) * DAY);
  return {
    origin: over.origin ?? mumbai,
    destination: over.destination ?? goa,
    departureWindowStart: start,
    departureWindowEnd: new Date(start.getTime() + 3_600_000),
    passengerCapacity: over.seats ?? 6,
  };
}

describe('isNearby', () => {
  it('accepts the same place and a close one, not a far one', () => {
    expect(isNearby(mumbai, mumbai)).toBe(true);
    expect(isNearby(mumbai, thane)).toBe(true);
    expect(isNearby(mumbai, pune)).toBe(false);
    expect(isNearby(mumbai, goa)).toBe(false);
  });
});

describe('pickAlternatives', () => {
  it('keeps the same route and a nearby origin or destination', () => {
    const rows = [offer(), offer({ origin: thane }), offer({ origin: pune })];
    expect(pickAlternatives(rows, trip)).toHaveLength(2);
  });

  it('drops offers outside the window and with too few seats', () => {
    const rows = [
      offer({ daysFromRequest: ALTERNATIVE_WINDOW_DAYS }),
      offer({ daysFromRequest: ALTERNATIVE_WINDOW_DAYS + 1 }),
      offer({ daysFromRequest: -ALTERNATIVE_WINDOW_DAYS - 1 }),
      offer({ seats: 2 }),
    ];
    expect(pickAlternatives(rows, trip)).toHaveLength(1);
  });

  it('puts exact routes first, then the closest departure', () => {
    const near = offer({ origin: thane, daysFromRequest: 0 });
    const exactLater = offer({ daysFromRequest: 1 });
    const exactSooner = offer({ daysFromRequest: 0 });
    expect(pickAlternatives([near, exactLater, exactSooner], trip)).toEqual([
      exactSooner,
      exactLater,
      near,
    ]);
  });

  it('returns at most the limit, and none when nothing fits', () => {
    const many = Array.from({ length: ALTERNATIVE_LIMIT + 3 }, () => offer());
    expect(pickAlternatives(many, trip)).toHaveLength(ALTERNATIVE_LIMIT);
    expect(pickAlternatives([], trip)).toEqual([]);
  });

  it('lists none once the requested departure has passed', () => {
    const rows = [offer(), offer({ daysFromRequest: 1 })];
    expect(pickAlternatives(rows, { ...trip, now: at })).toEqual([]);
    expect(
      pickAlternatives(rows, { ...trip, now: new Date(at.getTime() + DAY) }),
    ).toEqual([]);
    expect(
      pickAlternatives(rows, { ...trip, now: new Date(at.getTime() - 1) }),
    ).toHaveLength(2);
  });
});

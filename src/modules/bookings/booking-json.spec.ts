import { describe, expect, it } from 'vitest';
import {
  BookingJsonError,
  type CancellationTerms,
  type Itinerary,
  parseCancellationTerms,
  parseItinerary,
} from './booking-json.js';

const ITINERARY: Itinerary = {
  version: 1,
  source: 'SEARCH',
  searchId: '7d4b2b0e-5c2f-4a39-9a51-0a8d6a8c1f10',
  resultId: '3f1e9e55-1d1c-4b8e-8f4e-0c6b8f1d2a33',
  tripType: 'ROUND_TRIP',
  passengerCount: 2,
  legs: [
    {
      originId: 'a1',
      originName: 'Mumbai',
      destinationId: 'b2',
      destinationName: 'Goa',
      departureAt: '2026-12-01T06:00:00.000Z',
    },
    {
      originId: 'b2',
      originName: 'Goa',
      destinationId: 'a1',
      destinationName: 'Mumbai',
      departureAt: '2026-12-01T12:00:00.000Z',
    },
  ],
  roundTripStrategy: 'WAIT',
  aircraft: {
    id: 'c3',
    manufacturer: 'Embraer',
    model: 'Phenom 300',
    category: 'LIGHT_JET',
    passengerCapacity: 7,
  },
  operatorName: 'Skyline Aviation',
  distanceKm: 860,
  flightMinutes: 130,
  emptyLeg: null,
};

const TERMS: CancellationTerms = {
  version: 1,
  source: 'PLATFORM',
  summary: 'Cancellation conditions are set by the operator.',
  charges: [],
  acceptedAt: '2026-11-19T10:00:00.000Z',
};

describe('parseItinerary', () => {
  it('accepts the written shape and returns an equal copy', () => {
    expect(parseItinerary(structuredClone(ITINERARY))).toEqual(ITINERARY);
    const oneWay = {
      ...ITINERARY,
      tripType: 'ONE_WAY',
      legs: [ITINERARY.legs[0]],
      roundTripStrategy: null,
      flightMinutes: null,
    };
    expect(parseItinerary(oneWay)).toEqual(oneWay);
  });

  it.each([
    ['an unknown key', { ...ITINERARY, passengers: [] }],
    [
      'a missing key',
      Object.fromEntries(
        Object.entries(ITINERARY).filter(([key]) => key !== 'operatorName'),
      ),
    ],
    ['another version', { ...ITINERARY, version: 2 }],
    ['a round trip with one leg', { ...ITINERARY, legs: [ITINERARY.legs[0]] }],
    [
      'a local departure time',
      {
        ...ITINERARY,
        legs: [
          { ...ITINERARY.legs[0], departureAt: '2026-12-01T06:00:00' },
          ITINERARY.legs[1],
        ],
      },
    ],
    [
      'an unknown aircraft category',
      { ...ITINERARY, aircraft: { ...ITINERARY.aircraft, category: 'UFO' } },
    ],
    ['a fractional distance', { ...ITINERARY, distanceKm: 1.5 }],
    ['an unknown strategy', { ...ITINERARY, roundTripStrategy: 'FERRY' }],
  ])('refuses %s', (_name, value) => {
    expect(() => parseItinerary(value)).toThrow(BookingJsonError);
  });
});

describe('parseCancellationTerms', () => {
  it('accepts the written shape, with and without charges', () => {
    expect(parseCancellationTerms(structuredClone(TERMS))).toEqual(TERMS);
    const tiered = {
      ...TERMS,
      source: 'OPERATOR_QUOTE',
      charges: [
        { minHoursBeforeDeparture: 72, chargePercent: 10 },
        { minHoursBeforeDeparture: 24, chargePercent: 50 },
        { minHoursBeforeDeparture: 0, chargePercent: 100 },
      ],
    };
    expect(parseCancellationTerms(tiered)).toEqual(tiered);
  });

  it.each([
    ['an unknown key', { ...TERMS, refundable: true }],
    ['an empty summary', { ...TERMS, summary: '' }],
    ['an unknown source', { ...TERMS, source: 'CUSTOMER' }],
    [
      'a charge over 100 percent',
      {
        ...TERMS,
        charges: [{ minHoursBeforeDeparture: 0, chargePercent: 101 }],
      },
    ],
    [
      'charges out of order',
      {
        ...TERMS,
        charges: [
          { minHoursBeforeDeparture: 24, chargePercent: 50 },
          { minHoursBeforeDeparture: 72, chargePercent: 10 },
        ],
      },
    ],
    [
      'a charge with an unknown key',
      {
        ...TERMS,
        charges: [{ minHoursBeforeDeparture: 0, chargePercent: 100, flat: 5 }],
      },
    ],
    ['no acceptance time', { ...TERMS, acceptedAt: 'yesterday' }],
  ])('refuses %s', (_name, value) => {
    expect(() => parseCancellationTerms(value)).toThrow(BookingJsonError);
  });
});

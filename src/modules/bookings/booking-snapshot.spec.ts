import { describe, expect, it, vi } from 'vitest';
import type { PassengerRecord } from '../customers/customers.service.js';
import type { Revalidation } from '../search/search.service.js';
import {
  BOOKING_HOLD_HOURS,
  holdExpiry,
  itineraryFrom,
  lastFour,
  passengerSnapshot,
  requestTerms,
  revalidationOutcome,
} from './booking-snapshot.js';

const PRICED: NonNullable<Revalidation['current']> = {
  operatorId: 'op',
  priced: true,
  totalMinor: 52_179_600,
  currency: 'INR',
  validUntil: new Date('2026-11-19T11:00:00.000Z'),
  hold: {
    startsAt: new Date('2026-12-01T05:00:00.000Z'),
    endsAt: new Date('2026-12-01T07:10:00.000Z'),
  },
  saveCalculation: vi.fn(),
};

const REVALIDATION: Revalidation = {
  searchId: '7d4b2b0e-5c2f-4a39-9a51-0a8d6a8c1f10',
  resultId: '3f1e9e55-1d1c-4b8e-8f4e-0c6b8f1d2a33',
  category: 'PRIVATE_CHARTER',
  legs: [
    {
      originId: 'a1',
      originName: 'Mumbai',
      destinationId: 'b2',
      destinationName: 'Goa',
      departureAt: '2026-12-01T06:00:00.000Z',
    },
  ],
  passengerCount: 2,
  result: {
    resultId: '3f1e9e55-1d1c-4b8e-8f4e-0c6b8f1d2a33',
    aircraft: {
      id: 'c3',
      manufacturer: 'Embraer',
      model: 'Phenom 300',
      category: 'LIGHT_JET',
      passengerCapacity: 7,
    },
    operatorName: 'Skyline Aviation',
    distanceKm: 430,
    flightMinutes: 65,
    tripType: 'ONE_WAY',
    returnAt: null,
    roundTripStrategy: null,
    price: { priceType: 'ESTIMATE', amountMinor: 52_179_600, currency: 'INR' },
    incomplete: false,
    validUntil: '2026-11-19T10:30:00.000Z',
    warnings: ['Landing-site permission to be confirmed'],
  },
  current: PRICED,
};

describe('revalidationOutcome (rule 3)', () => {
  const expected = { totalMinor: 52_179_600, currency: 'INR' };

  it('refuses when the aircraft can no longer fly the trip', () => {
    expect(revalidationOutcome(null, expected)).toEqual({
      kind: 'unavailable',
    });
  });

  it('refuses a result priced on request', () => {
    expect(
      revalidationOutcome({ operatorId: 'op', priced: false }, expected),
    ).toEqual({ kind: 'priceOnRequest' });
  });

  it('refuses a changed price and carries the new estimate', () => {
    const current = { ...PRICED, totalMinor: 53_400_000 };
    expect(revalidationOutcome(current, expected)).toEqual({
      kind: 'priceChanged',
      totalMinor: 53_400_000,
      currency: 'INR',
      validUntil: PRICED.validUntil,
    });
    expect(
      revalidationOutcome({ ...PRICED, currency: 'USD' }, expected).kind,
    ).toBe('priceChanged');
  });

  it('accepts the agreed price, including a new estimate agreed to', () => {
    expect(revalidationOutcome(PRICED, expected)).toEqual({ kind: 'ok' });
    expect(
      revalidationOutcome(
        { ...PRICED, totalMinor: 53_400_000 },
        { totalMinor: 53_400_000, currency: 'INR' },
      ),
    ).toEqual({ kind: 'ok' });
  });
});

describe('itineraryFrom', () => {
  it('copies the trip, and nothing about price or warnings', () => {
    expect(itineraryFrom(REVALIDATION)).toEqual({
      version: 1,
      source: 'SEARCH',
      searchId: REVALIDATION.searchId,
      resultId: REVALIDATION.resultId,
      tripType: 'ONE_WAY',
      passengerCount: 2,
      legs: REVALIDATION.legs,
      roundTripStrategy: null,
      aircraft: REVALIDATION.result.aircraft,
      operatorName: 'Skyline Aviation',
      distanceKm: 430,
      flightMinutes: 65,
    });
  });
});

describe('requestTerms (rule 9)', () => {
  it('snapshots the note shown, word for word, with no charges', () => {
    const at = new Date('2026-11-19T10:00:00.000Z');
    expect(requestTerms('Shown with the result.', at)).toEqual({
      version: 1,
      source: 'PLATFORM',
      summary: 'Shown with the result.',
      charges: [],
      acceptedAt: '2026-11-19T10:00:00.000Z',
    });
  });
});

describe('passengerSnapshot', () => {
  const passenger: PassengerRecord = {
    id: 'p1',
    firstName: 'Kavya',
    lastName: 'Rao',
    dateOfBirth: new Date('1990-04-12'),
    gender: 'FEMALE',
    nationality: 'IN',
    documentType: 'PASSPORT',
    documentNumber: 'P1234567',
    documentExpiry: new Date('2031-01-31'),
    specialAssistance: 'Wheelchair to the aircraft',
  };
  const encrypt = (plain: string) => `enc(${plain})`;

  it('copies the passenger and encrypts the document number and assistance', () => {
    expect(passengerSnapshot(passenger, encrypt)).toEqual({
      passengerId: 'p1',
      firstName: 'Kavya',
      lastName: 'Rao',
      dateOfBirth: passenger.dateOfBirth,
      gender: 'FEMALE',
      nationality: 'IN',
      documentType: 'PASSPORT',
      documentNumber: 'enc(P1234567)',
      documentExpiry: passenger.documentExpiry,
      specialAssistance: 'enc(Wheelchair to the aircraft)',
    });
  });

  it('keeps empty sensitive fields empty', () => {
    const snapshot = passengerSnapshot(
      { ...passenger, documentNumber: null, specialAssistance: null },
      encrypt,
    );
    expect(snapshot.documentNumber).toBeNull();
    expect(snapshot.specialAssistance).toBeNull();
  });

  it('shows only the last four characters of a document number', () => {
    expect(lastFour('P1234567')).toBe('4567');
    expect(lastFour('A1234')).toBe('1234');
    expect(lastFour(null)).toBeNull();
  });

  it('never shows the whole of a number of four characters or fewer', () => {
    for (const short of ['1', '12', '123', '1234']) {
      expect(lastFour(short)).toBe('••••');
    }
  });
});

describe('holdExpiry', () => {
  const now = new Date('2026-11-19T10:00:00.000Z');

  it(`lapses ${BOOKING_HOLD_HOURS} hours after the request`, () => {
    expect(holdExpiry(now, new Date('2026-12-01T00:00:00.000Z'))).toEqual(
      new Date('2026-11-20T10:00:00.000Z'),
    );
  });

  it('never outlasts the trip it holds', () => {
    const endsAt = new Date('2026-11-19T15:00:00.000Z');
    expect(holdExpiry(now, endsAt)).toEqual(endsAt);
  });
});

import { describe, expect, it } from 'vitest';
import {
  EmptyLegPricingBasis,
  EmptyLegStatus,
  PriceType,
  Role,
} from '../../generated/prisma/enums.js';
import {
  changedFields,
  COMMITTED_FIELDS,
  MATERIAL_FIELDS,
  nextEmptyLegStatus,
  type OfferTerms,
  priceTypeOf,
  statusAfterEdit,
  termsIssues,
} from './empty-leg-rules.js';

const NOW = new Date('2026-12-01T00:00:00Z');
const hours = (n: number) => new Date(NOW.getTime() + n * 3_600_000);

function terms(overrides: Partial<OfferTerms> = {}): OfferTerms {
  return {
    aircraftId: 'a',
    originId: 'o',
    destinationId: 'd',
    departureWindowStart: hours(48),
    departureWindowEnd: hours(60),
    passengerCapacity: 4,
    priceMinor: 25_000_000n,
    expiresAt: hours(40),
    bookingConditions: 'Subject to the aircraft moving as planned.',
    ...overrides,
  };
}

describe('nextEmptyLegStatus', () => {
  it('publishes at once when review is not required', () => {
    expect(
      nextEmptyLegStatus('publish', EmptyLegStatus.DRAFT, Role.OPERATOR_STAFF),
    ).toEqual({ to: EmptyLegStatus.PUBLISHED });
  });

  it('sends a published draft to review when review is required', () => {
    expect(
      nextEmptyLegStatus('publish', EmptyLegStatus.DRAFT, Role.OPERATOR_ADMIN, {
        reviewRequired: true,
      }),
    ).toEqual({ to: EmptyLegStatus.PENDING_REVIEW });
  });

  it('lets only operations and super administrators decide a review', () => {
    expect(
      nextEmptyLegStatus(
        'approve',
        EmptyLegStatus.PENDING_REVIEW,
        Role.OPERATOR_ADMIN,
      ),
    ).toEqual({ refused: 'role' });
    expect(
      nextEmptyLegStatus('approve', EmptyLegStatus.PENDING_REVIEW, Role.OPS),
    ).toEqual({ to: EmptyLegStatus.PUBLISHED });
    expect(
      nextEmptyLegStatus(
        'approve',
        EmptyLegStatus.PENDING_REVIEW,
        Role.FINANCE_ADMIN,
      ),
    ).toEqual({ refused: 'role' });
  });

  it('needs a reason to reject, and returns the offer to draft', () => {
    expect(
      nextEmptyLegStatus('reject', EmptyLegStatus.PENDING_REVIEW, Role.OPS, {
        reason: '  ',
      }),
    ).toEqual({ refused: 'reason' });
    expect(
      nextEmptyLegStatus(
        'reject',
        EmptyLegStatus.PENDING_REVIEW,
        Role.SUPER_ADMIN,
        { reason: 'Wrong aircraft' },
      ),
    ).toEqual({ to: EmptyLegStatus.DRAFT });
  });

  it('never reopens a withdrawn, expired or booked offer', () => {
    for (const status of [
      EmptyLegStatus.WITHDRAWN,
      EmptyLegStatus.EXPIRED,
      EmptyLegStatus.BOOKED,
    ]) {
      expect(
        nextEmptyLegStatus('withdraw', status, Role.OPERATOR_ADMIN),
      ).toEqual({ refused: 'state' });
      expect(nextEmptyLegStatus('expire', status, null)).toEqual({
        refused: 'state',
      });
    }
  });

  it('expires only through the system, never a person', () => {
    expect(
      nextEmptyLegStatus('expire', EmptyLegStatus.PUBLISHED, Role.OPS),
    ).toEqual({ refused: 'role' });
    expect(
      nextEmptyLegStatus('expire', EmptyLegStatus.PUBLISHED, null),
    ).toEqual({ to: EmptyLegStatus.EXPIRED });
  });
});

describe('statusAfterEdit', () => {
  it('returns an edited published offer to review only when review is required', () => {
    expect(statusAfterEdit(EmptyLegStatus.PUBLISHED, false)).toBe(
      EmptyLegStatus.PUBLISHED,
    );
    expect(statusAfterEdit(EmptyLegStatus.PUBLISHED, true)).toBe(
      EmptyLegStatus.PENDING_REVIEW,
    );
    expect(statusAfterEdit(EmptyLegStatus.DRAFT, true)).toBe(
      EmptyLegStatus.DRAFT,
    );
  });
});

describe('priceTypeOf', () => {
  it('labels an operator price a quote and never confirmed', () => {
    expect(priceTypeOf(EmptyLegPricingBasis.OPERATOR_PRICE)).toBe(
      PriceType.QUOTE,
    );
    for (const basis of Object.values(EmptyLegPricingBasis)) {
      expect(priceTypeOf(basis)).not.toBe(PriceType.CONFIRMED);
    }
  });
});

describe('changedFields', () => {
  it('compares dates and prices by value', () => {
    const before = terms();
    const after = terms({
      departureWindowStart: new Date(before.departureWindowStart.getTime()),
      priceMinor: 20_000_000n,
    });
    expect(changedFields(before, after, MATERIAL_FIELDS)).toEqual([
      'priceMinor',
    ]);
  });

  it('fixes the aircraft, the route and the validity under a live request', () => {
    const before = terms();
    const after = terms({
      aircraftId: 'b',
      originId: 'o2',
      destinationId: 'd2',
      expiresAt: hours(30),
    });
    expect(changedFields(before, after, COMMITTED_FIELDS)).toEqual([
      'aircraftId',
      'originId',
      'destinationId',
      'expiresAt',
    ]);
  });

  it('fixes every term of the offer under a live request', () => {
    expect([...COMMITTED_FIELDS].sort()).toEqual(Object.keys(terms()).sort());
  });
});

describe('termsIssues', () => {
  it('accepts a sound offer', () => {
    expect(termsIssues(terms(), 8, NOW)).toEqual([]);
  });

  it('refuses a window that runs backwards or is too long', () => {
    expect(
      termsIssues(terms({ departureWindowEnd: hours(47) }), 8, NOW),
    ).toContainEqual({
      field: 'departureTo',
      issue: 'must be after departureFrom',
    });
    expect(
      termsIssues(
        terms({ departureWindowEnd: hours(48 + 15 * 24) }),
        8,
        NOW,
      ).map((i) => i.field),
    ).toContain('departureTo');
  });

  it('refuses validity in the past or after the window ends', () => {
    expect(
      termsIssues(terms({ expiresAt: hours(-1) }), 8, NOW).map((i) => i.field),
    ).toEqual(['validUntil']);
    expect(
      termsIssues(terms({ expiresAt: hours(61) }), 8, NOW).map((i) => i.field),
    ).toEqual(['validUntil']);
  });

  it('refuses more seats than the aircraft has and a round trip to nowhere', () => {
    const fields = termsIssues(
      terms({ passengerCapacity: 9, destinationId: 'o' }),
      8,
      NOW,
    ).map((i) => i.field);
    expect(fields).toEqual(['destinationId', 'seatsAvailable']);
  });
});

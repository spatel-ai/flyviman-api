import { describe, expect, it } from 'vitest';
import {
  CODE_PATTERN,
  engineInput,
  normalizeCode,
  promotionProblem,
  promotionStatus,
  type PromotionTerms,
} from './promotions.js';

const NOW = new Date('2026-12-01T00:00:00Z');

const PROMO: PromotionTerms = {
  id: 'p1',
  code: 'WINTER10',
  name: 'Winter offer',
  kind: 'PERCENT',
  percentBasisPoints: 1000,
  amountMinor: null,
  category: null,
  originId: null,
  destinationId: null,
  startsAt: new Date('2026-11-01T00:00:00Z'),
  endsAt: new Date('2027-01-01T00:00:00Z'),
  maxUses: null,
  maxUsesPerCustomer: null,
  endedAt: null,
};

const TRIP = {
  now: NOW,
  category: 'PRIVATE_CHARTER',
  originId: 'A',
  destinationId: 'B',
};
const NONE = { total: 0, customer: 0 };

describe('promotionProblem', () => {
  it('accepts a code in force with no limits', () => {
    expect(promotionProblem(PROMO, TRIP, NONE)).toBeNull();
  });

  it('refuses an unknown code, and one not started yet as unknown', () => {
    expect(promotionProblem(null, TRIP, NONE)).toBe('PROMO_CODE_INVALID');
    expect(
      promotionProblem(
        { ...PROMO, startsAt: new Date('2026-12-02T00:00:00Z') },
        TRIP,
        NONE,
      ),
    ).toBe('PROMO_CODE_INVALID');
  });

  it('refuses a code past its window or ended early', () => {
    expect(promotionProblem({ ...PROMO, endsAt: NOW }, TRIP, NONE)).toBe(
      'PROMO_CODE_EXPIRED',
    );
    expect(
      promotionProblem(
        { ...PROMO, endedAt: new Date('2026-11-20T00:00:00Z') },
        TRIP,
        NONE,
      ),
    ).toBe('PROMO_CODE_EXPIRED');
  });

  it('refuses another category', () => {
    expect(
      promotionProblem({ ...PROMO, category: 'HELICOPTER' }, TRIP, NONE),
    ).toBe('PROMO_CODE_NOT_APPLICABLE');
    expect(
      promotionProblem({ ...PROMO, category: 'PRIVATE_CHARTER' }, TRIP, NONE),
    ).toBeNull();
  });

  it('matches the route in either direction, and nothing else', () => {
    const route = { ...PROMO, originId: 'B', destinationId: 'A' };
    expect(promotionProblem(route, TRIP, NONE)).toBeNull();
    expect(promotionProblem(route, { ...TRIP, destinationId: 'C' }, NONE)).toBe(
      'PROMO_CODE_NOT_APPLICABLE',
    );
  });

  it('refuses once the overall cap is used up', () => {
    const capped = { ...PROMO, maxUses: 3 };
    expect(
      promotionProblem(capped, TRIP, { total: 2, customer: 0 }),
    ).toBeNull();
    expect(promotionProblem(capped, TRIP, { total: 3, customer: 0 })).toBe(
      'PROMO_CODE_LIMIT_REACHED',
    );
  });

  it('refuses once the customer has used their share', () => {
    const capped = { ...PROMO, maxUsesPerCustomer: 1 };
    expect(
      promotionProblem(capped, TRIP, { total: 5, customer: 0 }),
    ).toBeNull();
    expect(promotionProblem(capped, TRIP, { total: 5, customer: 1 })).toBe(
      'PROMO_CODE_LIMIT_REACHED',
    );
    // Not signed in: the customer's share is checked when they book.
    expect(
      promotionProblem(capped, TRIP, { total: 5, customer: null }),
    ).toBeNull();
  });
});

describe('codes', () => {
  it('normalises to upper case without spaces', () => {
    expect(normalizeCode('  winter10 ')).toBe('WINTER10');
  });

  it('accepts letters, digits and inner dashes only', () => {
    expect(CODE_PATTERN.test('WINTER-10')).toBe(true);
    expect(CODE_PATTERN.test('AB')).toBe(false);
    expect(CODE_PATTERN.test('-AB')).toBe(false);
    expect(CODE_PATTERN.test('A B')).toBe(false);
  });
});

describe('engineInput', () => {
  it('turns basis points into a percent', () => {
    expect(engineInput({ ...PROMO, percentBasisPoints: 1250 })).toEqual({
      id: 'p1',
      code: 'WINTER10',
      name: 'Winter offer',
      kind: 'PERCENT',
      percent: 12.5,
    });
  });

  it('passes a fixed amount', () => {
    expect(
      engineInput({
        ...PROMO,
        kind: 'FIXED',
        percentBasisPoints: null,
        amountMinor: 50_000,
      }),
    ).toMatchObject({ kind: 'FIXED', amountMinor: 50_000 });
  });
});

describe('promotionStatus', () => {
  it('is scheduled, active, then ended', () => {
    expect(promotionStatus(PROMO, new Date('2026-10-01T00:00:00Z'))).toBe(
      'SCHEDULED',
    );
    expect(promotionStatus(PROMO, NOW)).toBe('ACTIVE');
    expect(promotionStatus(PROMO, PROMO.endsAt)).toBe('ENDED');
    expect(promotionStatus({ ...PROMO, endedAt: NOW }, NOW)).toBe('ENDED');
  });
});

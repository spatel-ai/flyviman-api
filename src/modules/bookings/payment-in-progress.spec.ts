import { describe, expect, it } from 'vitest';
import { PaymentStatus } from '../../generated/prisma/enums.js';
import {
  PAYMENT_IN_PROGRESS_MAX_AGE_HOURS,
  holdsHoldExpiry,
  paymentInProgressUntil,
  paymentInProgressWhere,
} from './payment-in-progress.js';

const NOW = new Date('2026-11-20T12:00:00Z');
const HOUR = 3_600_000;

function ago(hours: number): Date {
  return new Date(NOW.getTime() - hours * HOUR);
}

describe('holdsHoldExpiry', () => {
  it('keeps a booking past its hold while a payment waits on the gateway', () => {
    expect(
      holdsHoldExpiry(
        [{ status: PaymentStatus.PENDING, createdAt: ago(1) }],
        NOW,
      ),
    ).toBe(true);
  });

  it('lets it expire with no payment pending', () => {
    expect(holdsHoldExpiry([], NOW)).toBe(false);
    expect(
      holdsHoldExpiry(
        [
          { status: PaymentStatus.INITIATED, createdAt: ago(1) },
          { status: PaymentStatus.FAILED, createdAt: ago(1) },
        ],
        NOW,
      ),
    ).toBe(false);
  });

  it('lets it expire once the pending payment is stale (the payments sweep stopped asking)', () => {
    expect(PAYMENT_IN_PROGRESS_MAX_AGE_HOURS).toBe(48);
    expect(
      holdsHoldExpiry(
        [
          {
            status: PaymentStatus.PENDING,
            createdAt: ago(PAYMENT_IN_PROGRESS_MAX_AGE_HOURS),
          },
        ],
        NOW,
      ),
    ).toBe(false);
    expect(
      holdsHoldExpiry(
        [
          {
            status: PaymentStatus.PENDING,
            createdAt: ago(PAYMENT_IN_PROGRESS_MAX_AGE_HOURS - 0.01),
          },
        ],
        NOW,
      ),
    ).toBe(true);
  });
});

describe('paymentInProgressWhere', () => {
  it('is a pending payment, with no age limit unless one is asked for', () => {
    expect(paymentInProgressWhere()).toEqual({
      status: PaymentStatus.PENDING,
    });
    expect(paymentInProgressWhere(NOW)).toEqual({
      status: PaymentStatus.PENDING,
      createdAt: { gt: ago(PAYMENT_IN_PROGRESS_MAX_AGE_HOURS) },
    });
  });
});

describe('paymentInProgressUntil', () => {
  it('is the 48-hour bound, the moment the hold-expiry job stops waiting', () => {
    const createdAt = ago(1);
    const until = paymentInProgressUntil(createdAt);
    expect(until.getTime() - createdAt.getTime()).toBe(
      PAYMENT_IN_PROGRESS_MAX_AGE_HOURS * HOUR,
    );
    const pending = [{ status: PaymentStatus.PENDING, createdAt }];
    expect(holdsHoldExpiry(pending, new Date(until.getTime() - 1))).toBe(true);
    expect(holdsHoldExpiry(pending, until)).toBe(false);
  });
});

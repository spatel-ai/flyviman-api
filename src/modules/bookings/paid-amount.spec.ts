import { describe, expect, it } from 'vitest';
import {
  PaymentReviewReason,
  PaymentStatus,
  RefundStatus,
} from '../../generated/prisma/enums.js';
import {
  creditedMinor,
  netPaidMinor,
  type PaidPayment,
} from './paid-amount.js';

function payment(overrides: Partial<PaidPayment> = {}): PaidPayment {
  return {
    status: PaymentStatus.SUCCEEDED,
    reviewReason: null,
    amountMinor: 1_000n,
    refunds: [],
    ...overrides,
  };
}

describe('netPaidMinor', () => {
  it('counts only payments whose money arrived', () => {
    expect(
      netPaidMinor([
        payment(),
        payment({ status: PaymentStatus.INITIATED }),
        payment({ status: PaymentStatus.PENDING }),
        payment({ status: PaymentStatus.FAILED }),
        payment({
          status: PaymentStatus.PARTIALLY_REFUNDED,
          amountMinor: 500n,
        }),
      ]),
    ).toBe(1_500n);
  });

  it('leaves out extra money but keeps a payment flagged for a duplicate capture', () => {
    expect(
      netPaidMinor([
        payment({ reviewReason: PaymentReviewReason.BOOKING_CLOSED }),
        payment({ reviewReason: PaymentReviewReason.ALREADY_PAID }),
        payment({ reviewReason: PaymentReviewReason.DUPLICATE_CAPTURE }),
      ]),
    ).toBe(1_000n);
  });

  it('subtracts refunds completed or under way, not failed ones', () => {
    expect(
      netPaidMinor([
        payment({
          status: PaymentStatus.REFUND_PENDING,
          refunds: [
            { status: RefundStatus.COMPLETED, amountMinor: 100n },
            { status: RefundStatus.PENDING, amountMinor: 200n },
            { status: RefundStatus.REQUESTED, amountMinor: 50n },
            { status: RefundStatus.FAILED, amountMinor: 400n },
          ],
        }),
      ]),
    ).toBe(650n);
  });

  it('is 0 with nothing paid', () => {
    expect(netPaidMinor([])).toBe(0n);
  });
});

describe('creditedMinor', () => {
  it('counts the money that arrived towards the booking, less extra money', () => {
    expect(
      creditedMinor([
        payment(),
        payment({ status: PaymentStatus.PENDING }),
        payment({ reviewReason: PaymentReviewReason.BOOKING_CLOSED }),
        payment({ reviewReason: PaymentReviewReason.ALREADY_PAID }),
        payment({ reviewReason: PaymentReviewReason.DUPLICATE_CAPTURE }),
      ]),
    ).toBe(2_000n);
  });

  it('never deducts a refund: money returned is not money owed', () => {
    const refunded = payment({
      status: PaymentStatus.PARTIALLY_REFUNDED,
      refunds: [
        { status: RefundStatus.COMPLETED, amountMinor: 300n },
        { status: RefundStatus.PENDING, amountMinor: 200n },
      ],
    });
    expect(creditedMinor([refunded])).toBe(1_000n);
    expect(netPaidMinor([refunded])).toBe(500n);
  });
});

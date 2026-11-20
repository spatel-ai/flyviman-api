import { describe, expect, it } from 'vitest';
import {
  BookingPaymentStatus,
  BookingStatus,
  PaymentModel,
  PaymentPurpose,
  PaymentStatus,
  PriceType,
  RefundStatus,
} from '../../generated/prisma/enums.js';
import {
  amountDue,
  bookingPaymentStatusAfterSuccess,
  bookingPaymentSummary,
  depositMinor,
  isDuplicateCapture,
  nextPaymentStatus,
  outcomeOfGatewayStatus,
  type PayableBooking,
  paymentStatusFromRefunds,
  refundableRemainderMinor,
  reviewOnSuccess,
} from './payment-rules.js';

const NOW = new Date('2026-11-20T00:00:00.000Z');

const due: PayableBooking = {
  status: BookingStatus.AWAITING_PAYMENT,
  priceType: PriceType.CONFIRMED,
  paymentModel: PaymentModel.B_OPERATOR_CONFIRMED,
  operatorAccepted: true,
  paymentStatus: BookingPaymentStatus.UNPAID,
  totalMinor: 18_000_000n,
  paidMinor: 0n,
  departureAt: new Date('2026-12-01T06:00:00.000Z'),
};

describe('depositMinor', () => {
  it('takes the percent of the total, rounded up to the next paisa', () => {
    expect(depositMinor(18_000_000n, 25)).toBe(4_500_000n);
    expect(depositMinor(100_001n, 25)).toBe(25_001n);
    expect(depositMinor(3n, 25)).toBe(1n);
    expect(depositMinor(18_000_000n, 100)).toBe(18_000_000n);
    expect(depositMinor(199n, 1)).toBe(2n);
  });

  it('refuses a percent outside 1 to 100, a fraction, or no total', () => {
    for (const percent of [0, 101, 12.5, -5, Number.NaN]) {
      expect(() => depositMinor(1_000n, percent)).toThrow(RangeError);
    }
    expect(() => depositMinor(0n, 25)).toThrow(RangeError);
  });
});

describe('amountDue', () => {
  it('Model A and B take the full confirmed total', () => {
    for (const paymentModel of [
      PaymentModel.A_INSTANT,
      PaymentModel.B_OPERATOR_CONFIRMED,
    ]) {
      expect(amountDue({ ...due, paymentModel }, 25, NOW)).toEqual({
        due: true,
        purpose: 'FULL',
        amountMinor: 18_000_000n,
      });
    }
  });

  it('Model C takes the configured deposit', () => {
    expect(
      amountDue({ ...due, paymentModel: PaymentModel.C_DEPOSIT }, 25, NOW),
    ).toEqual({ due: true, purpose: 'DEPOSIT', amountMinor: 4_500_000n });
    expect(
      amountDue({ ...due, paymentModel: PaymentModel.C_DEPOSIT }, 40, NOW),
    ).toEqual({ due: true, purpose: 'DEPOSIT', amountMinor: 7_200_000n });
  });

  it('Model B waits for the operator; A and C do not ask', () => {
    const unaccepted = { ...due, operatorAccepted: false };
    expect(amountDue(unaccepted, 25, NOW)).toMatchObject({
      due: false,
      code: 'PAYMENT_NOT_DUE',
    });
    expect(
      amountDue(
        { ...unaccepted, paymentModel: PaymentModel.A_INSTANT },
        25,
        NOW,
      ).due,
    ).toBe(true);
  });

  it('never charges an estimate, a live fare or a booking not awaiting payment', () => {
    for (const priceType of [
      PriceType.ESTIMATE,
      PriceType.QUOTE,
      PriceType.LIVE_FARE,
    ]) {
      expect(amountDue({ ...due, priceType }, 25, NOW)).toMatchObject({
        due: false,
        code: 'PAYMENT_NOT_DUE',
      });
    }
    for (const status of Object.values(BookingStatus)) {
      if (status === BookingStatus.AWAITING_PAYMENT) continue;
      expect(amountDue({ ...due, status }, 25, NOW)).toMatchObject({
        due: false,
        code: 'PAYMENT_NOT_DUE',
      });
    }
  });

  it('refuses a booking with any money in already (the balance aside)', () => {
    for (const paymentStatus of Object.values(BookingPaymentStatus)) {
      if (
        paymentStatus === BookingPaymentStatus.UNPAID ||
        paymentStatus === BookingPaymentStatus.PARTIALLY_PAID
      ) {
        continue;
      }
      expect(amountDue({ ...due, paymentStatus }, 25, NOW)).toMatchObject({
        due: false,
        code: 'PAYMENT_ALREADY_PAID',
      });
    }
  });
});

describe('amountDue: the Model C balance', () => {
  const deposited: PayableBooking = {
    ...due,
    status: BookingStatus.CONFIRMED,
    paymentModel: PaymentModel.C_DEPOSIT,
    paymentStatus: BookingPaymentStatus.PARTIALLY_PAID,
    paidMinor: 4_500_000n,
  };

  it('is the total less what was paid, while confirmed, scheduled or awaiting payment', () => {
    for (const status of [
      BookingStatus.AWAITING_PAYMENT,
      BookingStatus.CONFIRMED,
      BookingStatus.SCHEDULED,
    ]) {
      expect(amountDue({ ...deposited, status }, 25, NOW)).toEqual({
        due: true,
        purpose: 'BALANCE',
        amountMinor: 13_500_000n,
      });
    }
  });

  it('is not due after departure, on a closed booking or on another model', () => {
    expect(
      amountDue({ ...deposited, departureAt: NOW }, 25, NOW),
    ).toMatchObject({ due: false, code: 'PAYMENT_NOT_DUE' });
    for (const status of [
      BookingStatus.CANCELLED,
      BookingStatus.COMPLETED,
      BookingStatus.EXPIRED,
    ]) {
      expect(amountDue({ ...deposited, status }, 25, NOW)).toMatchObject({
        due: false,
        code: 'PAYMENT_NOT_DUE',
      });
    }
    expect(
      amountDue(
        { ...deposited, paymentModel: PaymentModel.B_OPERATOR_CONFIRMED },
        25,
        NOW,
      ),
    ).toMatchObject({ due: false, code: 'PAYMENT_NOT_DUE' });
  });

  it('is already paid when nothing is left', () => {
    expect(
      amountDue({ ...deposited, paidMinor: 18_000_000n }, 25, NOW),
    ).toMatchObject({ due: false, code: 'PAYMENT_ALREADY_PAID' });
  });

  it('makes the booking PAID once it succeeds', () => {
    expect(
      bookingPaymentStatusAfterSuccess(
        BookingPaymentStatus.PARTIALLY_PAID,
        PaymentPurpose.BALANCE,
      ),
    ).toBe('PAID');
  });
});

describe('nextPaymentStatus (event ordering)', () => {
  const P = PaymentStatus;

  it('moves forward only', () => {
    expect(nextPaymentStatus(P.INITIATED, 'PENDING')).toBe(P.PENDING);
    expect(nextPaymentStatus(P.INITIATED, 'SUCCEEDED')).toBe(P.SUCCEEDED);
    expect(nextPaymentStatus(P.PENDING, 'SUCCEEDED')).toBe(P.SUCCEEDED);
    expect(nextPaymentStatus(P.PENDING, 'FAILED')).toBe(P.FAILED);
    expect(nextPaymentStatus(P.INITIATED, 'FAILED')).toBe(P.FAILED);
  });

  it('a failure after a success, or a checkout after the outcome, is ignored', () => {
    expect(nextPaymentStatus(P.SUCCEEDED, 'FAILED')).toBeNull();
    expect(nextPaymentStatus(P.SUCCEEDED, 'PENDING')).toBeNull();
    expect(nextPaymentStatus(P.FAILED, 'PENDING')).toBeNull();
    expect(nextPaymentStatus(P.SUCCEEDED, 'SUCCEEDED')).toBeNull();
    expect(nextPaymentStatus(P.FAILED, 'FAILED')).toBeNull();
  });

  it('a captured retry after a failure on the same order is kept', () => {
    expect(nextPaymentStatus(P.FAILED, 'SUCCEEDED')).toBe(P.SUCCEEDED);
  });

  it('never undoes a refund', () => {
    for (const current of [
      P.REFUND_PENDING,
      P.PARTIALLY_REFUNDED,
      P.REFUNDED,
    ]) {
      for (const outcome of ['PENDING', 'FAILED', 'SUCCEEDED'] as const) {
        expect(nextPaymentStatus(current, outcome)).toBeNull();
      }
    }
  });

  it('whatever order the same events arrive in, the result is the same', () => {
    const outcomes = ['PENDING', 'FAILED', 'SUCCEEDED'] as const;
    const permutations = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    for (const order of permutations) {
      let status: PaymentStatus = P.INITIATED;
      for (const index of order) {
        status = nextPaymentStatus(status, outcomes[index]) ?? status;
      }
      expect(status).toBe(P.SUCCEEDED);
    }
  });
});

describe('bookingPaymentStatusAfterSuccess', () => {
  const B = BookingPaymentStatus;

  it('a full payment pays, a deposit partly pays', () => {
    expect(bookingPaymentStatusAfterSuccess(B.UNPAID, 'FULL')).toBe(B.PAID);
    expect(bookingPaymentStatusAfterSuccess(B.UNPAID, 'DEPOSIT')).toBe(
      B.PARTIALLY_PAID,
    );
    expect(bookingPaymentStatusAfterSuccess(B.PARTIALLY_PAID, 'BALANCE')).toBe(
      B.PAID,
    );
  });

  it('never moves the summary backwards', () => {
    expect(bookingPaymentStatusAfterSuccess(B.PAID, 'DEPOSIT')).toBeNull();
    expect(bookingPaymentStatusAfterSuccess(B.PAID, 'FULL')).toBeNull();
    expect(bookingPaymentStatusAfterSuccess(B.REFUNDED, 'FULL')).toBeNull();
  });
});

describe('reviewOnSuccess', () => {
  it('flags money for a closed booking', () => {
    for (const status of [
      BookingStatus.EXPIRED,
      BookingStatus.CANCELLED,
      BookingStatus.QUOTE_DECLINED,
      BookingStatus.OPERATOR_UNAVAILABLE,
    ]) {
      expect(
        reviewOnSuccess(
          { status, paymentStatus: BookingPaymentStatus.UNPAID },
          PaymentPurpose.FULL,
        ),
      ).toBe('BOOKING_CLOSED');
    }
  });

  it('flags a second payment for a paid booking', () => {
    expect(
      reviewOnSuccess(
        {
          status: BookingStatus.AWAITING_PAYMENT,
          paymentStatus: BookingPaymentStatus.PAID,
        },
        PaymentPurpose.FULL,
      ),
    ).toBe('ALREADY_PAID');
    // A balance after the booking was fully paid is extra money too.
    expect(
      reviewOnSuccess(
        {
          status: BookingStatus.CONFIRMED,
          paymentStatus: BookingPaymentStatus.PAID,
        },
        PaymentPurpose.BALANCE,
      ),
    ).toBe('ALREADY_PAID');
  });

  it('needs nothing for the payment the booking was waiting for', () => {
    expect(
      reviewOnSuccess(
        {
          status: BookingStatus.AWAITING_PAYMENT,
          paymentStatus: BookingPaymentStatus.UNPAID,
        },
        PaymentPurpose.DEPOSIT,
      ),
    ).toBeNull();
    // The balance after a deposit is expected, not a second payment.
    expect(
      reviewOnSuccess(
        {
          status: BookingStatus.CONFIRMED,
          paymentStatus: BookingPaymentStatus.PARTIALLY_PAID,
        },
        PaymentPurpose.BALANCE,
      ),
    ).toBeNull();
  });
});

describe('isDuplicateCapture', () => {
  const paid = { status: PaymentStatus.SUCCEEDED, providerPaymentId: 'pay_1' };

  it('flags another gateway payment captured on a paid order', () => {
    expect(isDuplicateCapture(paid, 'pay_2')).toBe(true);
    // Also once the first capture is being refunded: money moved twice.
    expect(
      isDuplicateCapture(
        { status: PaymentStatus.REFUND_PENDING, providerPaymentId: 'pay_1' },
        'pay_2',
      ),
    ).toBe(true);
  });

  it('does not flag a repeat of the same capture, or a capture on an unpaid order', () => {
    expect(isDuplicateCapture(paid, 'pay_1')).toBe(false);
    expect(isDuplicateCapture(paid, undefined)).toBe(false);
    for (const status of [
      PaymentStatus.INITIATED,
      PaymentStatus.PENDING,
      PaymentStatus.FAILED,
    ]) {
      expect(
        isDuplicateCapture({ status, providerPaymentId: 'pay_1' }, 'pay_2'),
      ).toBe(false);
    }
  });
});

describe('outcomeOfGatewayStatus', () => {
  it('settles only captured and failed payments', () => {
    expect(outcomeOfGatewayStatus('captured')).toBe(PaymentStatus.SUCCEEDED);
    expect(outcomeOfGatewayStatus('failed')).toBe(PaymentStatus.FAILED);
    expect(outcomeOfGatewayStatus('created')).toBeNull();
    expect(outcomeOfGatewayStatus('authorized')).toBeNull();
    expect(outcomeOfGatewayStatus('refunded')).toBeNull();
  });
});

describe('refunds', () => {
  const R = RefundStatus;
  const refund = (status: RefundStatus, amountMinor: bigint) => ({
    status,
    amountMinor,
  });

  it('refundableRemainderMinor: the amount less refunds completed or under way', () => {
    expect(refundableRemainderMinor(1_000n, [])).toBe(1_000n);
    expect(
      refundableRemainderMinor(1_000n, [
        refund(R.COMPLETED, 300n),
        refund(R.PENDING, 200n),
        refund(R.REQUESTED, 100n),
        refund(R.FAILED, 400n),
      ]),
    ).toBe(400n);
    expect(
      refundableRemainderMinor(1_000n, [refund(R.COMPLETED, 1_000n)]),
    ).toBe(0n);
  });

  it('paymentStatusFromRefunds: pending, then partially refunded, then refunded', () => {
    expect(paymentStatusFromRefunds(1_000n, [])).toBe('SUCCEEDED');
    expect(paymentStatusFromRefunds(1_000n, [refund(R.REQUESTED, 300n)])).toBe(
      'REFUND_PENDING',
    );
    expect(paymentStatusFromRefunds(1_000n, [refund(R.COMPLETED, 300n)])).toBe(
      'PARTIALLY_REFUNDED',
    );
    // A second partial refund from PARTIALLY_REFUNDED.
    expect(
      paymentStatusFromRefunds(1_000n, [
        refund(R.COMPLETED, 300n),
        refund(R.PENDING, 700n),
      ]),
    ).toBe('REFUND_PENDING');
    expect(
      paymentStatusFromRefunds(1_000n, [
        refund(R.COMPLETED, 300n),
        refund(R.COMPLETED, 700n),
      ]),
    ).toBe('REFUNDED');
  });

  it('paymentStatusFromRefunds: a failed refund leaves the payment as it was', () => {
    expect(paymentStatusFromRefunds(1_000n, [refund(R.FAILED, 1_000n)])).toBe(
      'SUCCEEDED',
    );
    expect(
      paymentStatusFromRefunds(1_000n, [
        refund(R.COMPLETED, 300n),
        refund(R.FAILED, 700n),
      ]),
    ).toBe('PARTIALLY_REFUNDED');
  });
});

describe('bookingPaymentSummary', () => {
  const R = RefundStatus;
  const paid = (
    amountMinor: bigint,
    refunds: { status: RefundStatus; amountMinor: bigint }[] = [],
    status: PaymentStatus = PaymentStatus.SUCCEEDED,
  ) => ({ status, amountMinor, refunds });

  it('is REFUND_PENDING while any refund is under way', () => {
    expect(
      bookingPaymentSummary(1_000n, [paid(1_000n, [refund(R.PENDING, 1n)])]),
    ).toBe('REFUND_PENDING');
  });

  it('is REFUNDED after a full refund, or a partial one under a charge', () => {
    expect(
      bookingPaymentSummary(1_000n, [
        paid(1_000n, [refund(R.COMPLETED, 1_000n)]),
      ]),
    ).toBe('REFUNDED');
    expect(
      bookingPaymentSummary(1_000n, [
        paid(1_000n, [refund(R.COMPLETED, 800n)]),
      ]),
    ).toBe('REFUNDED');
  });

  it('stays PAID when a second payment for a paid booking is refunded', () => {
    expect(
      bookingPaymentSummary(1_000n, [
        paid(1_000n),
        paid(1_000n, [refund(R.COMPLETED, 1_000n)]),
      ]),
    ).toBe('PAID');
  });

  it('goes back after a failed refund, and ignores money that never arrived', () => {
    expect(
      bookingPaymentSummary(1_000n, [paid(1_000n, [refund(R.FAILED, 1_000n)])]),
    ).toBe('PAID');
    expect(
      bookingPaymentSummary(1_000n, [
        paid(250n),
        paid(750n, [], PaymentStatus.PENDING),
      ]),
    ).toBe('PARTIALLY_PAID');
    expect(bookingPaymentSummary(1_000n, [])).toBe('UNPAID');
  });

  function refund(status: RefundStatus, amountMinor: bigint) {
    return { status, amountMinor };
  }
});

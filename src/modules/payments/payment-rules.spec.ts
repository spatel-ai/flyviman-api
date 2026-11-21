import { describe, expect, it } from 'vitest';
import {
  BookingPaymentStatus,
  BookingStatus,
  PaymentModel,
  PaymentPurpose,
  PaymentReviewReason,
  PaymentStatus,
  PriceType,
  RefundStatus,
} from '../../generated/prisma/enums.js';
import { creditedMinor, netPaidMinor } from '../bookings/paid-amount.js';
import {
  amountDue,
  bookingPaymentStatusAfterSuccess,
  bookingPaymentSummary,
  confirmationKeptMinor,
  depositMinor,
  hasOpenGatewayFlag,
  isDuplicateCapture,
  nextPaymentStatus,
  outcomeOfGatewayStatus,
  overOnlineLimit,
  type PayableBooking,
  paymentStatusFromRefunds,
  refundableRemainderMinor,
  refundReportMatches,
  reviewOnSuccess,
  storedEventPayload,
} from './payment-rules.js';

const NOW = new Date('2026-11-20T00:00:00.000Z');

const due: PayableBooking = {
  status: BookingStatus.AWAITING_PAYMENT,
  priceType: PriceType.CONFIRMED,
  paymentModel: PaymentModel.B_OPERATOR_CONFIRMED,
  operatorAccepted: true,
  paymentStatus: BookingPaymentStatus.UNPAID,
  totalMinor: 18_000_000n,
  creditedMinor: 0n,
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

describe('overOnlineLimit', () => {
  it('is over only above a set limit, compared in whole paise', () => {
    expect(overOnlineLimit(62_953_000n, 50_000_000)).toBe(true);
    expect(overOnlineLimit(50_000_001n, 50_000_000)).toBe(true);
    expect(overOnlineLimit(50_000_000n, 50_000_000)).toBe(false);
    expect(overOnlineLimit(31_152_000n, 50_000_000)).toBe(false);
  });

  it('is never over when no limit is set', () => {
    expect(overOnlineLimit(10_000_000_000n, undefined)).toBe(false);
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
    creditedMinor: 4_500_000n,
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
      amountDue({ ...deposited, creditedMinor: 18_000_000n }, 25, NOW),
    ).toMatchObject({ due: false, code: 'PAYMENT_ALREADY_PAID' });
  });

  it('is not due when no deposit counts towards the booking (a deposit flagged for refund)', () => {
    expect(
      amountDue(
        {
          ...deposited,
          status: BookingStatus.AWAITING_PAYMENT,
          creditedMinor: 0n,
        },
        25,
        NOW,
      ),
    ).toMatchObject({ due: false, code: 'PAYMENT_NOT_DUE' });
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
  it('settles only captured (refunded too: captured first) and failed payments', () => {
    expect(outcomeOfGatewayStatus('captured')).toBe(PaymentStatus.SUCCEEDED);
    expect(outcomeOfGatewayStatus('refunded')).toBe(PaymentStatus.SUCCEEDED);
    expect(outcomeOfGatewayStatus('failed')).toBe(PaymentStatus.FAILED);
    expect(outcomeOfGatewayStatus('created')).toBeNull();
    expect(outcomeOfGatewayStatus('authorized')).toBeNull();
  });
});

describe('refundReportMatches', () => {
  it('matches only the amount and currency recorded', () => {
    const refund = { amountMinor: 10_000n, currency: 'INR' };
    expect(
      refundReportMatches(refund, { amountMinor: 10_000, currency: 'INR' }),
    ).toBe(true);
    for (const report of [
      { amountMinor: 9_999, currency: 'INR' },
      { amountMinor: 10_000, currency: 'USD' },
      { currency: 'INR' },
      { amountMinor: 10_000.5, currency: 'INR' },
    ]) {
      expect(refundReportMatches(refund, report)).toBe(false);
    }
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
  const LIVE = BookingStatus.CONFIRMED;
  const CLOSED = BookingStatus.CANCELLED;
  const paid = (
    amountMinor: bigint,
    refunds: { status: RefundStatus; amountMinor: bigint }[] = [],
    status: PaymentStatus = PaymentStatus.SUCCEEDED,
    reviewReason: PaymentReviewReason | null = null,
  ) => ({ status, reviewReason, amountMinor, refunds });
  const extra = (
    reason: PaymentReviewReason,
    amountMinor: bigint,
    refunds: { status: RefundStatus; amountMinor: bigint }[] = [],
  ) => paid(amountMinor, refunds, PaymentStatus.SUCCEEDED, reason);

  /**
   * What a live Model C booking of 1,000 (deposit 250) owes after these
   * payments, through the same functions the services use: the summary,
   * the money credited (`creditedMinor`) and `amountDue`.
   */
  function owed(payments: ReturnType<typeof paid>[]) {
    const summary = bookingPaymentSummary(1_000n, payments, LIVE);
    return {
      summary,
      due: amountDue(
        {
          ...due,
          status: LIVE,
          paymentModel: PaymentModel.C_DEPOSIT,
          paymentStatus: summary,
          totalMinor: 1_000n,
          creditedMinor: creditedMinor(payments),
        },
        25,
        NOW,
      ),
    };
  }

  it('is REFUND_PENDING while any refund is under way', () => {
    expect(
      bookingPaymentSummary(
        1_000n,
        [paid(1_000n, [refund(R.PENDING, 1n)])],
        LIVE,
      ),
    ).toBe('REFUND_PENDING');
  });

  it('is REFUNDED on a cancelled booking after a full refund, or a partial one under a charge', () => {
    expect(
      bookingPaymentSummary(
        1_000n,
        [paid(1_000n, [refund(R.COMPLETED, 1_000n)])],
        CLOSED,
      ),
    ).toBe('REFUNDED');
    expect(
      bookingPaymentSummary(
        1_000n,
        [paid(1_000n, [refund(R.COMPLETED, 800n)])],
        CLOSED,
      ),
    ).toBe('REFUNDED');
  });

  it('is PARTIALLY_PAID on a live deposit booking whose duplicate deposit was refunded, so the balance is due', () => {
    // The second deposit was flagged ALREADY_PAID when it succeeded.
    expect(
      owed([
        paid(250n),
        extra(PaymentReviewReason.ALREADY_PAID, 250n, [
          refund(R.COMPLETED, 250n),
        ]),
      ]),
    ).toEqual({
      summary: 'PARTIALLY_PAID',
      due: { due: true, purpose: 'BALANCE', amountMinor: 750n },
    });
  });

  it('a goodwill refund on a live deposit booking never reopens or grows the balance', () => {
    // Deposit only: the balance stays the total less the deposit.
    expect(owed([paid(250n, [refund(R.COMPLETED, 100n)])])).toEqual({
      summary: 'PARTIALLY_PAID',
      due: { due: true, purpose: 'BALANCE', amountMinor: 750n },
    });
    // Paid in full: still paid, nothing due.
    expect(owed([paid(250n), paid(750n, [refund(R.COMPLETED, 200n)])])).toEqual(
      {
        summary: 'PAID',
        due: expect.objectContaining({
          due: false,
          code: 'PAYMENT_ALREADY_PAID',
        }),
      },
    );
  });

  it('is PAID after a goodwill refund on a live paid booking; REFUNDED only when nothing is kept', () => {
    expect(
      bookingPaymentSummary(
        1_000n,
        [paid(1_000n, [refund(R.COMPLETED, 200n)])],
        LIVE,
      ),
    ).toBe('PAID');
    expect(
      bookingPaymentSummary(
        1_000n,
        [paid(1_000n, [refund(R.COMPLETED, 1_000n)])],
        LIVE,
      ),
    ).toBe('REFUNDED');
  });

  it('stays PAID when a second payment for a paid booking is refunded', () => {
    expect(
      bookingPaymentSummary(
        1_000n,
        [
          paid(1_000n),
          extra(PaymentReviewReason.ALREADY_PAID, 1_000n, [
            refund(R.COMPLETED, 1_000n),
          ]),
        ],
        LIVE,
      ),
    ).toBe('PAID');
  });

  it('a live booking whose payment was flagged for refund (confirmation blocked) reads PAID until it is refunded', () => {
    const AWAITING = BookingStatus.AWAITING_PAYMENT;
    const flagged = (
      refunds: { status: RefundStatus; amountMinor: bigint }[],
    ) => extra(PaymentReviewReason.BOOKING_CLOSED, 1_000n, refunds);
    expect(
      bookingPaymentSummary(
        1_000n,
        [flagged([refund(R.FAILED, 1_000n)])],
        AWAITING,
      ),
    ).toBe('PAID');
    expect(
      bookingPaymentSummary(
        1_000n,
        [flagged([refund(R.COMPLETED, 1_000n)])],
        AWAITING,
      ),
    ).toBe('REFUNDED');
    // Never money towards the booking: nothing credited, nothing kept.
    expect(creditedMinor([flagged([])])).toBe(0n);
  });

  it('goes back after a failed refund, and ignores money that never arrived', () => {
    expect(
      bookingPaymentSummary(
        1_000n,
        [paid(1_000n, [refund(R.FAILED, 1_000n)])],
        LIVE,
      ),
    ).toBe('PAID');
    expect(
      bookingPaymentSummary(
        1_000n,
        [paid(250n), paid(750n, [], PaymentStatus.PENDING)],
        LIVE,
      ),
    ).toBe('PARTIALLY_PAID');
    expect(bookingPaymentSummary(1_000n, [], LIVE)).toBe('UNPAID');
  });

  function refund(status: RefundStatus, amountMinor: bigint) {
    return { status, amountMinor };
  }
});

describe('confirmationKeptMinor', () => {
  it('is the deposit for Model C and the total for A and B', () => {
    expect(confirmationKeptMinor(PaymentModel.C_DEPOSIT, 100_001n, 25)).toEqual(
      { requiredMinor: 25_001n, warning: null },
    );
    expect(confirmationKeptMinor(PaymentModel.A_INSTANT, 100_001n, 25)).toEqual(
      { requiredMinor: 100_001n, warning: null },
    );
    expect(
      confirmationKeptMinor(PaymentModel.B_OPERATOR_CONFIRMED, 100_001n, 25),
    ).toEqual({ requiredMinor: 100_001n, warning: null });
  });

  it('never throws on a bad deposit percent: the full total, with a warning', () => {
    for (const percent of [0, -5, 101, 12.5, Number.NaN]) {
      const kept = confirmationKeptMinor(
        PaymentModel.C_DEPOSIT,
        100_001n,
        percent,
      );
      expect(kept.requiredMinor).toBe(100_001n);
      expect(kept.warning).toMatch(/full total/);
    }
    // Only Model C reads the percent.
    expect(
      confirmationKeptMinor(PaymentModel.A_INSTANT, 100_001n, 0).warning,
    ).toBeNull();
    expect(() => depositMinor(100_001n, 0)).toThrow(RangeError);
  });

  it('a deposit booking that kept less than the deposit after a refund does not meet it', () => {
    const { requiredMinor: required } = confirmationKeptMinor(
      PaymentModel.C_DEPOSIT,
      1_000n,
      25,
    );
    const kept = netPaidMinor([
      {
        status: PaymentStatus.PARTIALLY_REFUNDED,
        reviewReason: null,
        amountMinor: 250n,
        refunds: [{ status: RefundStatus.COMPLETED, amountMinor: 200n }],
      },
    ]);
    expect(kept < required).toBe(true);
    // The duplicate deposit refunded leaves the deposit kept.
    const keptAfterDuplicate = netPaidMinor([
      {
        status: PaymentStatus.SUCCEEDED,
        reviewReason: null,
        amountMinor: 250n,
        refunds: [],
      },
      {
        status: PaymentStatus.REFUNDED,
        reviewReason: PaymentReviewReason.ALREADY_PAID,
        amountMinor: 250n,
        refunds: [{ status: RefundStatus.COMPLETED, amountMinor: 250n }],
      },
    ]);
    expect(keptAfterDuplicate >= required).toBe(true);
  });
});

describe('hasOpenGatewayFlag', () => {
  it.each([
    PaymentReviewReason.AMOUNT_MISMATCH,
    PaymentReviewReason.DUPLICATE_CAPTURE,
  ])('%s is open until resolved', (reviewReason) => {
    expect(hasOpenGatewayFlag({ reviewReason, reviewResolvedAt: null })).toBe(
      true,
    );
    expect(
      hasOpenGatewayFlag({ reviewReason, reviewResolvedAt: new Date() }),
    ).toBe(false);
  });

  it.each([
    PaymentReviewReason.BOOKING_CLOSED,
    PaymentReviewReason.ALREADY_PAID,
    null,
  ])(
    '%s is not resolved here (the refund queue, or no flag)',
    (reviewReason) => {
      expect(hasOpenGatewayFlag({ reviewReason, reviewResolvedAt: null })).toBe(
        false,
      );
    },
  );
});

describe('storedEventPayload', () => {
  it("keeps the allowlisted fields at the top level, for the sweep's JSON-path lookup", () => {
    const event = {
      providerEventId: 'evt_1',
      type: 'payment.captured' as const,
      providerOrderId: 'order_1',
      providerPaymentId: 'pay_1',
      amountMinor: 1_250_000,
      currency: 'INR',
      status: 'captured',
      method: 'upi',
      createdAt: '2026-11-21T10:00:00.000Z',
    };
    expect(storedEventPayload(event)).toEqual(event);
  });

  it("keeps a refund notice's refund id and our receipt", () => {
    expect(
      storedEventPayload({
        providerEventId: 'evt_2',
        type: 'refund.processed',
        providerRefundId: 'rfnd_1',
        providerPaymentId: 'pay_1',
        receipt: 'FLY-RF-ABCDEF',
        amountMinor: 500,
        currency: 'INR',
      }),
    ).toEqual({
      providerEventId: 'evt_2',
      type: 'refund.processed',
      providerRefundId: 'rfnd_1',
      providerPaymentId: 'pay_1',
      receipt: 'FLY-RF-ABCDEF',
      amountMinor: 500,
      currency: 'INR',
    });
  });

  it('drops anything else an event carries: contact, VPA, card, nested objects', () => {
    const event = {
      providerEventId: 'evt_3',
      type: 'payment.captured' as const,
      providerOrderId: 'order_1',
      email: 'asha@example.com',
      contact: '+919800000000',
      vpa: 'asha@upi',
      card: { last4: '1111' },
      notes: { name: 'Asha' },
    };
    const stored = storedEventPayload(event);
    expect(stored).toEqual({
      providerEventId: 'evt_3',
      type: 'payment.captured',
      providerOrderId: 'order_1',
    });
    const text = JSON.stringify(stored);
    for (const value of ['asha', '9800000000', '1111']) {
      expect(text).not.toContain(value);
    }
  });

  it('keeps no inherited or non-scalar value', () => {
    const inherited = Object.create({ providerOrderId: 'order_x' }) as {
      providerEventId: string;
      type: 'other';
    };
    inherited.providerEventId = 'evt_4';
    inherited.type = 'other';
    expect(storedEventPayload(inherited)).toEqual({
      providerEventId: 'evt_4',
      type: 'other',
    });
    expect(
      storedEventPayload({
        providerEventId: 'evt_5',
        type: 'other',
        currency: { code: 'INR' } as unknown as string,
      }),
    ).toEqual({ providerEventId: 'evt_5', type: 'other' });
  });
});

import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception.js';
import { minorToNumber } from '../../common/money.js';
import {
  BookingStatus,
  PaymentReviewReason,
  PaymentStatus,
  RefundStatus,
  SettlementStatus,
} from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  EXTRA_MONEY,
  MONEY_IN,
  netPaidMinor,
} from '../bookings/paid-amount.js';
import { PricingService } from '../pricing/pricing.service.js';
import type {
  MismatchKind,
  ReconciliationMismatchDto,
  ReconciliationQueryDto,
  ReconciliationReportDto,
  ReconciliationTotalsDto,
} from './dto/reconciliation.dto.js';
import {
  bookingPaymentSummary,
  REFUNDABLE,
  refundableRemainderMinor,
} from './payment-rules.js';
import {
  REFUND_EXCEEDS_PAYABLE,
  unusableCalculation,
} from './settlement-rules.js';

const MAX_PERIOD_DAYS = 92;
/** A payment or refund without a final answer after this long is stuck. */
const STUCK_HOURS = 24;
const MAX_LISTED = 200;

/** Flags whose extra money is not on our record (the gateway's dashboard). */
const GATEWAY_FLAGS: readonly PaymentReviewReason[] = [
  PaymentReviewReason.AMOUNT_MISMATCH,
  PaymentReviewReason.DUPLICATE_CAPTURE,
];
const OPEN_REFUND: readonly RefundStatus[] = [
  RefundStatus.REQUESTED,
  RefundStatus.PENDING,
];

/** Counts and paise, summed as bigint and returned as numbers. */
type Totals = Record<keyof Omit<ReconciliationTotalsDto, 'currency'>, bigint>;

function emptyTotals(): Totals {
  return {
    paymentsCount: 0n,
    paymentsInMinor: 0n,
    extraMoneyMinor: 0n,
    refundsCompletedMinor: 0n,
    refundsOpenMinor: 0n,
    bookingsCount: 0n,
    bookingsKeptMinor: 0n,
    settlementsCount: 0n,
    settlementsPayableMinor: 0n,
    settlementsCommissionMinor: 0n,
    settlementsTaxMinor: 0n,
    settlementsPaidMinor: 0n,
  };
}

/**
 * The reconciliation report (M9, W4-2): for a period, our own record of
 * gateway payments, refunds, bookings and settlements, with what does not
 * agree. It reads our ledger only; it never asks the gateway (the status
 * sweep does that for payments without a final answer). Each total names
 * the timestamp it is counted by; the mismatches are checked, as they are
 * now, on every booking with a payment, refund or settlement in the
 * period, or completed in it.
 */
@Injectable()
export class ReconciliationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: PricingService,
  ) {}

  async report(
    query: ReconciliationQueryDto,
  ): Promise<ReconciliationReportDto> {
    const from = new Date(query.from);
    const to = new Date(query.to);
    const span = to.getTime() - from.getTime();
    if (!(span > 0) || span > MAX_PERIOD_DAYS * 86_400_000) {
      throw new AppException(
        'VALIDATION_ERROR',
        `The period must end after it starts and be at most ${MAX_PERIOD_DAYS} days.`,
        HttpStatus.BAD_REQUEST,
        [{ field: 'to', issue: 'period' }],
      );
    }
    const now = new Date();
    const stuckBefore = new Date(now.getTime() - STUCK_HOURS * 3_600_000);
    const period = { gte: from, lt: to };

    const byCurrency = new Map<string, Totals>();
    const totalsFor = (currency: string): Totals => {
      let totals = byCurrency.get(currency);
      if (!totals) {
        totals = emptyTotals();
        byCurrency.set(currency, totals);
      }
      return totals;
    };

    const [paid, refunds, created, paidOut] = await this.prisma.$transaction([
      this.prisma.payment.findMany({
        where: { status: { in: [...MONEY_IN] }, paidAt: period },
        select: { amountMinor: true, currency: true, reviewReason: true },
      }),
      this.prisma.refund.findMany({
        where: { createdAt: period },
        select: { amountMinor: true, currency: true, status: true },
      }),
      this.prisma.settlement.findMany({
        where: { createdAt: period },
        select: {
          payableMinor: true,
          commissionMinor: true,
          taxMinor: true,
          currency: true,
        },
      }),
      this.prisma.settlement.findMany({
        where: { paidAt: period },
        select: { payableMinor: true, currency: true, paymentReference: true },
      }),
    ]);
    for (const payment of paid) {
      const totals = totalsFor(payment.currency);
      totals.paymentsCount += 1n;
      totals.paymentsInMinor += payment.amountMinor;
      if (payment.reviewReason && EXTRA_MONEY.includes(payment.reviewReason)) {
        totals.extraMoneyMinor += payment.amountMinor;
      }
    }
    for (const refund of refunds) {
      const totals = totalsFor(refund.currency);
      if (refund.status === RefundStatus.COMPLETED) {
        totals.refundsCompletedMinor += refund.amountMinor;
      } else if (OPEN_REFUND.includes(refund.status)) {
        totals.refundsOpenMinor += refund.amountMinor;
      }
    }
    for (const settlement of created) {
      const totals = totalsFor(settlement.currency);
      totals.settlementsCount += 1n;
      totals.settlementsPayableMinor += settlement.payableMinor;
      totals.settlementsCommissionMinor += settlement.commissionMinor;
      totals.settlementsTaxMinor += settlement.taxMinor;
    }
    for (const settlement of paidOut) {
      totalsFor(settlement.currency).settlementsPaidMinor +=
        settlement.payableMinor;
    }

    const bookings = await this.prisma.booking.findMany({
      where: {
        OR: [
          { payments: { some: { createdAt: period } } },
          { payments: { some: { refunds: { some: { createdAt: period } } } } },
          { settlement: { OR: [{ createdAt: period }, { paidAt: period }] } },
          {
            status: BookingStatus.COMPLETED,
            operatorId: { not: null },
            updatedAt: period,
          },
        ],
      },
      select: {
        reference: true,
        status: true,
        totalMinor: true,
        currency: true,
        operatorId: true,
        paymentStatus: true,
        calculationId: true,
        acceptedQuote: { select: { calculationId: true } },
        payments: {
          select: {
            reference: true,
            status: true,
            reviewReason: true,
            amountMinor: true,
            currency: true,
            createdAt: true,
            refunds: {
              select: {
                reference: true,
                status: true,
                amountMinor: true,
                createdAt: true,
              },
            },
          },
        },
        settlement: {
          select: {
            id: true,
            status: true,
            payableMinor: true,
            commissionMinor: true,
            taxMinor: true,
          },
        },
      },
      orderBy: { reference: 'asc' },
    });

    const mismatches: ReconciliationMismatchDto[] = [];
    const flag = (
      kind: MismatchKind,
      detail: string,
      at: {
        bookingReference?: string;
        paymentReference?: string;
        refundReference?: string;
        settlementId?: string;
        amountMinor?: bigint;
        currency?: string;
      },
    ) => {
      mismatches.push({
        kind,
        bookingReference: at.bookingReference ?? null,
        paymentReference: at.paymentReference ?? null,
        refundReference: at.refundReference ?? null,
        settlementId: at.settlementId ?? null,
        detail,
        amountMinor:
          at.amountMinor === undefined ? null : minorToNumber(at.amountMinor),
        currency: at.currency ?? null,
      });
    };

    for (const booking of bookings) {
      const ref = { bookingReference: booking.reference };
      const currency = booking.currency;
      const kept = netPaidMinor(booking.payments);

      if (
        booking.payments.some(
          (payment) =>
            payment.createdAt >= from &&
            payment.createdAt < to &&
            MONEY_IN.includes(payment.status),
        )
      ) {
        const totals = totalsFor(currency);
        totals.bookingsCount += 1n;
        totals.bookingsKeptMinor += kept;
      }

      // The summary rule is what writes the status once refunds exist; before
      // that, a second payment (extra money) leaves the status as the first
      // made it, so such a booking is not compared.
      const refunded = booking.payments.some((p) => p.refunds.length > 0);
      const extra = booking.payments.some(
        (p) => p.reviewReason !== null && EXTRA_MONEY.includes(p.reviewReason),
      );
      const summary = bookingPaymentSummary(
        booking.totalMinor,
        booking.payments,
        booking.status,
      );
      if ((refunded || !extra) && summary !== booking.paymentStatus) {
        flag(
          'PAYMENT_SUMMARY_MISMATCH',
          `The booking shows ${booking.paymentStatus}; its payments say ${summary}.`,
          ref,
        );
      }

      for (const payment of booking.payments) {
        const at = {
          ...ref,
          paymentReference: payment.reference,
          currency: payment.currency,
        };
        if (
          payment.reviewReason &&
          GATEWAY_FLAGS.includes(payment.reviewReason)
        ) {
          flag(
            'PAYMENT_FLAGGED',
            `Flagged ${payment.reviewReason}: check the gateway’s dashboard.`,
            { ...at, amountMinor: payment.amountMinor },
          );
        }
        if (
          payment.reviewReason &&
          EXTRA_MONEY.includes(payment.reviewReason) &&
          REFUNDABLE.includes(payment.status)
        ) {
          const left = refundableRemainderMinor(
            payment.amountMinor,
            payment.refunds,
          );
          if (left > 0n) {
            flag(
              'EXTRA_MONEY_UNREFUNDED',
              `Paid ${payment.reviewReason === PaymentReviewReason.ALREADY_PAID ? 'twice' : 'after the booking closed'}; not yet refunded.`,
              { ...at, amountMinor: left },
            );
          }
        }
        if (
          payment.status === PaymentStatus.PENDING &&
          payment.createdAt < stuckBefore
        ) {
          flag(
            'PAYMENT_STUCK',
            `No final answer from the gateway after ${STUCK_HOURS} hours.`,
            { ...at, amountMinor: payment.amountMinor },
          );
        }
        for (const refund of payment.refunds) {
          if (
            OPEN_REFUND.includes(refund.status) &&
            refund.createdAt < stuckBefore
          ) {
            flag(
              'REFUND_STUCK',
              `Refund still ${refund.status} after ${STUCK_HOURS} hours.`,
              {
                ...at,
                refundReference: refund.reference,
                amountMinor: refund.amountMinor,
              },
            );
          }
        }
      }

      if (kept > booking.totalMinor) {
        flag(
          'KEPT_EXCEEDS_TOTAL',
          'More money is kept towards the booking than its price.',
          { ...ref, amountMinor: kept - booking.totalMinor, currency },
        );
      }

      const settlement = booking.settlement;
      if (!settlement) {
        if (
          booking.status === BookingStatus.COMPLETED &&
          booking.operatorId &&
          kept > 0n
        ) {
          const calculationId =
            booking.acceptedQuote?.calculationId ?? booking.calculationId;
          const why = unusableCalculation(
            calculationId
              ? await this.pricing.calculation(calculationId)
              : null,
            booking.totalMinor,
          );
          flag(
            'SETTLEMENT_MISSING',
            why
              ? `Completed with money kept, but no settlement can be worked out: ${why}`
              : 'Completed with money kept; the settlement job (every 5 minutes) has not created it yet.',
            { ...ref, amountMinor: kept, currency },
          );
        }
        continue;
      }
      const sum =
        settlement.payableMinor +
        settlement.commissionMinor +
        settlement.taxMinor;
      if (sum !== kept) {
        flag(
          'SETTLEMENT_AMOUNT_MISMATCH',
          sum > kept && settlement.payableMinor === 0n
            ? `${REFUND_EXCEEDS_PAYABLE} The ${settlement.status} settlement’s commission and tax (${sum} paise) are more than the ${kept} paise kept now.`
            : `The ${settlement.status} settlement adds up to ${sum} paise; ${kept} paise are kept now.`,
          {
            ...ref,
            settlementId: settlement.id,
            amountMinor: sum > kept ? sum - kept : kept - sum,
            currency,
          },
        );
      }
      if (
        (settlement.status === SettlementStatus.DUE ||
          settlement.status === SettlementStatus.PAID) &&
        booking.status !== BookingStatus.COMPLETED
      ) {
        flag(
          'SETTLEMENT_BOOKING_NOT_COMPLETED',
          `The settlement is ${settlement.status} but the booking is ${booking.status}.`,
          { ...ref, settlementId: settlement.id },
        );
      }
    }

    // A payout reference names one bank transfer to one operator (which may
    // pay several of its settlements): any paid in the period whose
    // reference is also on another operator's paid record (at any time,
    // ignoring case).
    const references = [
      ...new Set(
        paidOut.flatMap((settlement) =>
          settlement.paymentReference
            ? [settlement.paymentReference.toUpperCase()]
            : [],
        ),
      ),
    ];
    if (references.length > 0) {
      // upper() as the mark-paid check compares, never a pattern match.
      const ids = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Settlement"
        WHERE status = 'PAID'
          AND upper("paymentReference") = ANY(${references}::text[])`;
      const sharing = await this.prisma.settlement.findMany({
        where: { id: { in: ids.map((row) => row.id) } },
        select: {
          id: true,
          operatorId: true,
          paymentReference: true,
          payableMinor: true,
          currency: true,
          booking: { select: { reference: true } },
        },
        orderBy: [{ paymentReference: 'asc' }, { id: 'asc' }],
      });
      const byReference = new Map<string, typeof sharing>();
      for (const row of sharing) {
        const key = (row.paymentReference ?? '').toUpperCase();
        byReference.set(key, [...(byReference.get(key) ?? []), row]);
      }
      for (const rows of byReference.values()) {
        const operators = new Set(rows.map((row) => row.operatorId)).size;
        if (operators < 2) continue;
        for (const row of rows) {
          flag(
            'SETTLEMENT_REFERENCE_REUSED',
            `Payout reference ${row.paymentReference ?? ''} is on paid settlements of ${operators} operators.`,
            {
              bookingReference: row.booking.reference,
              settlementId: row.id,
              amountMinor: row.payableMinor,
              currency: row.currency,
            },
          );
        }
      }
    }

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      generatedAt: now.toISOString(),
      totals: [...byCurrency.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([currency, totals]) => ({
          currency,
          ...(Object.fromEntries(
            Object.entries(totals).map(([key, value]) => [
              key,
              minorToNumber(value),
            ]),
          ) as Omit<ReconciliationTotalsDto, 'currency'>),
        })),
      mismatches: mismatches.slice(0, MAX_LISTED),
      mismatchTotal: mismatches.length,
    };
  }
}

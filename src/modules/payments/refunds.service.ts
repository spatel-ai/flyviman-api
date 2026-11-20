import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception.js';
import {
  type IdempotencyClaim,
  markIdempotencyCommitted,
} from '../../common/idempotency/idempotency.store.js';
import { minorToNumber } from '../../common/money.js';
import { refundReference } from '../../common/reference.js';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  type PaymentReviewReason,
  PaymentStatus,
  RefundStatus,
} from '../../generated/prisma/enums.js';
import {
  type GatewayRefund,
  PaymentGatewayError,
  PaymentGatewayProvider,
  type WebhookEvent,
} from '../../integrations/payment/payment-gateway.provider.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import {
  BookingsService,
  type PayableBookingRow,
} from '../bookings/bookings.service.js';
import {
  EXTRA_MONEY,
  MONEY_IN,
  REFUND_HOLDS,
} from '../bookings/paid-amount.js';
import { cancellationsWithRefundDue } from '../bookings/refund-due.js';
import type {
  AdminRefundsQueryDto,
  CreateRefundDto,
  RefundDueItemDto,
  RefundResponseDto,
} from './dto/refund.dto.js';
import { providerOf } from './payments.service.js';
import {
  bookingPaymentSummary,
  paymentStatusFromRefunds,
  REFUNDABLE,
  refundableRemainderMinor,
} from './payment-rules.js';

/** Attempts at a fresh reference before giving up (31^6 codes). */
const REFERENCE_ATTEMPTS = 5;

/** Refunds still on their way; a notice settles them once. */
const OPEN_REFUND: RefundStatus[] = [
  RefundStatus.REQUESTED,
  RefundStatus.PENDING,
];

type RefundRow = Prisma.RefundGetPayload<object>;

/** What a refund change came from, kept in its audit record. */
type RefundSource = 'request' | 'gateway' | 'webhook' | 'webhook-redelivery';

function notFound(): AppException {
  return new AppException(
    'NOT_FOUND',
    'Payment not found.',
    HttpStatus.NOT_FOUND,
  );
}

/**
 * Refunds (M9, W4-1). Finance starts one for a payment, in full or in part
 * up to what is still refundable; the gateway returns the money and its
 * notice (`refund.processed` or `refund.failed`) settles the refund once.
 * A payment's status and the booking's payment summary are derived from
 * the refunds (`paymentStatusFromRefunds`, `bookingPaymentSummary`), never
 * the booking's own status (rule 2). Every change is audited (rule 6). Every
 * write locks the booking first, as payments do, so two refunds of one
 * payment, or a refund and a payment notice, are applied one after the
 * other. Nothing is refunded automatically: finance works from the refund
 * queue (`due`).
 */
@Injectable()
export class RefundsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly bookings: BookingsService,
    private readonly gateway: PaymentGatewayProvider,
  ) {}

  /**
   * Starts a refund in three steps, so money never moves without a record:
   * 1. In one transaction, under the booking's lock: the remainder is
   *    re-checked, the refund recorded `REQUESTED` with the idempotency key
   *    (both the header's and the stored one), and the payment and booking
   *    summary moved to `REFUND_PENDING`.
   * 2. The gateway is asked, outside any transaction, with the refund's
   *    reference as its receipt.
   * 3. Its answer is recorded: `PENDING` (or settled at once), `FAILED` for
   *    a definite refusal, which frees the amount again. A gateway that
   *    could not be reached leaves the refund `REQUESTED`: whether money
   *    moved is unknown, so it is never retried automatically and its
   *    notice still settles it (matched by the receipt).
   * The answer is the refund as recorded, never an error after step 1: a
   * failed gateway call shows as the refund's status.
   */
  async start(
    user: AuthUser,
    paymentReference: string,
    input: CreateRefundDto,
    claim: IdempotencyClaim,
    idempotencyKey: string,
  ): Promise<RefundResponseDto> {
    const found = await this.prisma.payment.findUnique({
      where: { reference: paymentReference },
      select: { id: true, bookingId: true },
    });
    if (!found) throw notFound();
    const storedKey = `${user.id}:${idempotencyKey.toLowerCase()}`;

    let refund: RefundRow;
    for (let attempt = 1; ; attempt += 1) {
      try {
        refund = await this.prisma.$transaction(async (tx) => {
          await markIdempotencyCommitted(tx, claim);
          const booking = await this.bookings.forPayment(
            { id: found.bookingId },
            tx,
          );
          if (!booking) throw notFound();
          const payment = await tx.payment.findUniqueOrThrow({
            where: { id: found.id },
            include: { refunds: true },
          });
          if (
            !REFUNDABLE.includes(payment.status) ||
            payment.providerPaymentId === null
          ) {
            throw new AppException(
              'PAYMENT_NOT_REFUNDABLE',
              'Only a payment whose money arrived can be refunded.',
              HttpStatus.CONFLICT,
              [{ field: 'status', issue: payment.status }],
            );
          }
          const reused = await tx.refund.findUnique({
            where: { idempotencyKey: storedKey },
            select: { id: true },
          });
          if (reused) {
            throw new AppException(
              'IDEMPOTENCY_CONFLICT',
              'This Idempotency-Key was already used for another refund.',
              HttpStatus.CONFLICT,
            );
          }
          const remainder = refundableRemainderMinor(
            payment.amountMinor,
            payment.refunds,
          );
          if (
            BigInt(input.amountMinor) > remainder ||
            input.currency !== payment.currency
          ) {
            throw new AppException(
              'REFUND_EXCEEDS_REMAINDER',
              'The refund is more than is left to refund on this payment.',
              HttpStatus.CONFLICT,
              [
                { field: 'refundableMinor', issue: String(remainder) },
                { field: 'currency', issue: payment.currency },
              ],
            );
          }
          const created = await tx.refund.create({
            data: {
              reference: refundReference(),
              paymentId: payment.id,
              provider: payment.provider,
              amountMinor: BigInt(input.amountMinor),
              currency: payment.currency,
              reason: input.reason,
              status: RefundStatus.REQUESTED,
              requestedById: user.id,
              idempotencyKey: storedKey,
            },
          });
          await this.audit.record(
            {
              action: 'refund.create',
              entityType: 'Refund',
              entityId: created.id,
              after: {
                reference: created.reference,
                paymentReference: payment.reference,
                bookingReference: booking.reference,
                amountMinor: input.amountMinor,
                currency: created.currency,
                status: created.status,
                refundableBeforeMinor: minorToNumber(remainder),
              },
              reason: input.reason,
            },
            tx,
          );
          await this.settle(tx, payment.id, booking, created.reference);
          return created;
        });
        break;
      } catch (error) {
        const clash =
          (error as { code?: unknown }).code === 'P2002' &&
          attempt < REFERENCE_ATTEMPTS;
        if (!clash) throw error;
      }
    }

    const payment = await this.prisma.payment.findUniqueOrThrow({
      where: { id: found.id },
      select: { providerPaymentId: true },
    });
    let answer: GatewayRefund | 'refused' | 'unreachable';
    try {
      answer = await this.gateway.createRefund({
        providerPaymentId: payment.providerPaymentId ?? '',
        amountMinor: minorToNumber(refund.amountMinor),
        receipt: refund.reference,
      });
    } catch (error) {
      if (!(error instanceof PaymentGatewayError)) throw error;
      answer = error.reason === 'UNAVAILABLE' ? 'unreachable' : 'refused';
    }
    if (answer !== 'unreachable') {
      await this.prisma.$transaction(async (tx) => {
        const booking = await this.bookings.forPayment(
          { id: found.bookingId },
          tx,
        );
        if (!booking) throw notFound();
        const current = await tx.refund.findUniqueOrThrow({
          where: { id: refund.id },
        });
        if (answer === 'refused') {
          await this.move(tx, current, RefundStatus.FAILED, booking, {
            source: 'gateway',
          });
          return;
        }
        const status =
          answer.status === 'processed'
            ? RefundStatus.COMPLETED
            : answer.status === 'failed'
              ? RefundStatus.FAILED
              : RefundStatus.PENDING;
        await this.move(tx, current, status, booking, {
          source: 'gateway',
          providerRefundId: answer.providerRefundId,
        });
      });
    }
    return this.toResponse(refund.id);
  }

  /**
   * Applies a verified refund notice once, inside the webhook's transaction.
   * The refund is found by its natural key, the gateway's refund id, or by
   * the receipt (our reference) when the notice beat our record of that id.
   * Only a refund still `REQUESTED` or `PENDING` moves, so a notice applied
   * twice (a redelivery, or a new event id for the same refund) changes
   * nothing. A notice for another amount is recorded in the audit trail and
   * not applied. Returns the payment it belongs to, or null when the refund
   * is unknown (stored unapplied by the caller).
   */
  async applyNotice(
    tx: Prisma.TransactionClient,
    event: WebhookEvent,
    source: 'webhook' | 'webhook-redelivery',
  ): Promise<string | null> {
    const found = await this.findForNotice(tx, event);
    if (!found) return null;
    const booking = await this.bookings.forPayment(
      { id: found.payment.bookingId },
      tx,
    );
    if (!booking) return null;
    // Re-read under the lock: another notice may have settled it.
    const refund = await tx.refund.findUniqueOrThrow({
      where: { id: found.id },
    });
    if (!OPEN_REFUND.includes(refund.status)) return refund.paymentId;
    if (
      event.amountMinor === undefined ||
      BigInt(event.amountMinor) !== refund.amountMinor ||
      event.currency !== refund.currency
    ) {
      await this.audit.record(
        {
          action: 'refund.flag',
          entityType: 'Refund',
          entityId: refund.id,
          before: { reference: refund.reference, status: refund.status },
          after: {
            reference: refund.reference,
            status: refund.status,
            flagged: 'AMOUNT_MISMATCH',
            reportedAmountMinor: event.amountMinor ?? null,
            reportedCurrency: event.currency ?? null,
            amountMinor: minorToNumber(refund.amountMinor),
            providerEventId: event.providerEventId,
          },
          actor: null,
        },
        tx,
      );
      return refund.paymentId;
    }
    await this.move(
      tx,
      refund,
      event.type === 'refund.processed'
        ? RefundStatus.COMPLETED
        : RefundStatus.FAILED,
      booking,
      {
        source,
        providerRefundId: event.providerRefundId,
        providerEventId: event.providerEventId,
      },
    );
    return refund.paymentId;
  }

  /**
   * The finance queue: payments to refund, oldest first. A cancellation's
   * outstanding refund due (recorded less refunds made since) is spread
   * over its unflagged payments, newest first; a success for a closed
   * booking or a second payment for a paid one is due in full. Payments
   * flagged `AMOUNT_MISMATCH` or `DUPLICATE_CAPTURE` are not here: their
   * extra money is not on a payment we can refund (the gateway's dashboard).
   */
  async due(
    page: number,
    pageSize: number,
  ): Promise<{ items: RefundDueItemDto[]; total: number }> {
    const items: RefundDueItemDto[] = [];
    const paymentSelect = {
      reference: true,
      status: true,
      amountMinor: true,
      currency: true,
      reviewReason: true,
      createdAt: true,
      paidAt: true,
      refunds: { select: { status: true, amountMinor: true, createdAt: true } },
      booking: {
        select: { reference: true, status: true, paymentStatus: true },
      },
    } as const;

    for (const cancellation of await cancellationsWithRefundDue(this.prisma)) {
      const payments = await this.prisma.payment.findMany({
        where: {
          bookingId: cancellation.bookingId,
          status: { in: [...MONEY_IN] },
          OR: [
            { reviewReason: null },
            { reviewReason: { notIn: [...EXTRA_MONEY] } },
          ],
        },
        select: paymentSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      const refundedSince = payments
        .flatMap((payment) => payment.refunds)
        .filter(
          (refund) =>
            REFUND_HOLDS.includes(refund.status) &&
            refund.createdAt >= cancellation.cancelledAt,
        )
        .reduce((total, refund) => total + refund.amountMinor, 0n);
      let left = cancellation.refundMinor - refundedSince;
      for (const payment of payments) {
        if (left <= 0n) break;
        const remainder = refundableRemainderMinor(
          payment.amountMinor,
          payment.refunds,
        );
        if (remainder <= 0n || !REFUNDABLE.includes(payment.status)) continue;
        const dueMinor = remainder < left ? remainder : left;
        left -= dueMinor;
        items.push(
          this.dueItem('CANCELLATION', payment, remainder, dueMinor, {
            since: cancellation.cancelledAt,
          }),
        );
      }
    }

    const flagged = await this.prisma.payment.findMany({
      where: {
        reviewReason: { in: [...EXTRA_MONEY] },
        status: { in: [...REFUNDABLE] },
      },
      select: paymentSelect,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    for (const payment of flagged) {
      const remainder = refundableRemainderMinor(
        payment.amountMinor,
        payment.refunds,
      );
      if (remainder <= 0n) continue;
      items.push(
        this.dueItem(
          payment.reviewReason as 'BOOKING_CLOSED' | 'ALREADY_PAID',
          payment,
          remainder,
          remainder,
          { since: payment.paidAt ?? payment.createdAt },
        ),
      );
    }

    items.sort((a, b) =>
      a.since === b.since
        ? a.paymentReference.localeCompare(b.paymentReference)
        : a.since.localeCompare(b.since),
    );
    const start = (page - 1) * pageSize;
    return { items: items.slice(start, start + pageSize), total: items.length };
  }

  private dueItem(
    kind: RefundDueItemDto['kind'],
    payment: {
      reference: string;
      status: PaymentStatus;
      amountMinor: bigint;
      currency: string;
      reviewReason: PaymentReviewReason | null;
      booking: {
        reference: string;
        status: RefundDueItemDto['bookingStatus'];
        paymentStatus: RefundDueItemDto['bookingPaymentStatus'];
      };
    },
    remainder: bigint,
    dueMinor: bigint,
    at: { since: Date },
  ): RefundDueItemDto {
    return {
      kind,
      bookingReference: payment.booking.reference,
      bookingStatus: payment.booking.status,
      bookingPaymentStatus: payment.booking.paymentStatus,
      paymentReference: payment.reference,
      paymentStatus: payment.status,
      paymentAmountMinor: minorToNumber(payment.amountMinor),
      refundableMinor: minorToNumber(remainder),
      dueMinor: minorToNumber(dueMinor),
      currency: payment.currency,
      since: at.since.toISOString(),
    };
  }

  private async findForNotice(
    tx: Prisma.TransactionClient,
    event: WebhookEvent,
  ) {
    const provider = providerOf(this.gateway);
    const include = {
      payment: { select: { bookingId: true, providerPaymentId: true } },
    } as const;
    if (event.providerRefundId) {
      const byId = await tx.refund.findUnique({
        where: {
          provider_providerRefundId: {
            provider,
            providerRefundId: event.providerRefundId,
          },
        },
        include,
      });
      if (byId) return byId;
    }
    if (!event.receipt) return null;
    const byReceipt = await tx.refund.findUnique({
      where: { reference: event.receipt },
      include,
    });
    // Only our own refund of that gateway payment, not yet given another id.
    if (
      !byReceipt ||
      byReceipt.provider !== provider ||
      byReceipt.payment.providerPaymentId !== event.providerPaymentId ||
      (byReceipt.providerRefundId !== null &&
        byReceipt.providerRefundId !== event.providerRefundId)
    ) {
      return null;
    }
    return byReceipt;
  }

  /**
   * Moves a refund on (only out of `REQUESTED` or `PENDING`, and only
   * forward: `REQUESTED` → `PENDING` → `COMPLETED` or `FAILED`), keeps the
   * gateway's refund id, audits, and re-derives the payment and booking.
   */
  private async move(
    tx: Prisma.TransactionClient,
    refund: RefundRow,
    to: RefundStatus,
    booking: PayableBookingRow,
    origin: {
      source: RefundSource;
      providerRefundId?: string;
      providerEventId?: string;
    },
  ): Promise<void> {
    const forward =
      OPEN_REFUND.includes(refund.status) &&
      to !== refund.status &&
      to !== RefundStatus.REQUESTED;
    const providerRefundId =
      refund.providerRefundId ?? origin.providerRefundId ?? null;
    if (!forward) {
      // A notice may have settled it first; keep the gateway's id anyway.
      if (providerRefundId !== refund.providerRefundId) {
        await tx.refund.update({
          where: { id: refund.id },
          data: { providerRefundId },
        });
      }
      return;
    }
    await tx.refund.update({
      where: { id: refund.id },
      data: { status: to, providerRefundId },
    });
    await this.audit.record(
      {
        action: 'refund.status',
        entityType: 'Refund',
        entityId: refund.id,
        before: { reference: refund.reference, status: refund.status },
        after: {
          reference: refund.reference,
          status: to,
          providerRefundId,
          ...origin,
        },
        actor: null,
      },
      tx,
    );
    await this.settle(tx, refund.paymentId, booking, refund.reference);
  }

  /**
   * Re-derives the payment's status and the booking's payment summary from
   * the refunds, writing (and auditing) only what changed.
   */
  private async settle(
    tx: Prisma.TransactionClient,
    paymentId: string,
    booking: PayableBookingRow,
    refundReference: string,
  ): Promise<void> {
    const payment = await tx.payment.findUniqueOrThrow({
      where: { id: paymentId },
      include: { refunds: { select: { status: true, amountMinor: true } } },
    });
    const status = paymentStatusFromRefunds(
      payment.amountMinor,
      payment.refunds,
    );
    if (status !== payment.status) {
      await tx.payment.update({
        where: { id: payment.id },
        data: { status },
      });
      await this.audit.record(
        {
          action: 'payment.status',
          entityType: 'Payment',
          entityId: payment.id,
          before: { reference: payment.reference, status: payment.status },
          after: {
            reference: payment.reference,
            status,
            refundReference,
          },
          actor: null,
        },
        tx,
      );
    }
    const payments = await tx.payment.findMany({
      where: { bookingId: booking.id },
      select: {
        status: true,
        reviewReason: true,
        amountMinor: true,
        refunds: { select: { status: true, amountMinor: true } },
      },
    });
    // Re-read: an earlier step of this transaction may have moved it.
    const current = await tx.booking.findUniqueOrThrow({
      where: { id: booking.id },
      select: { paymentStatus: true, status: true },
    });
    const summary = bookingPaymentSummary(
      booking.totalMinor,
      payments,
      current.status,
    );
    if (summary !== current.paymentStatus) {
      await this.bookings.recordPaymentStatus(
        tx,
        { ...booking, paymentStatus: current.paymentStatus },
        summary,
        { reference: payment.reference, purpose: payment.purpose },
      );
    }
  }

  /** Every refund, newest first, for finance (`GET /admin/refunds`). */
  async list(
    query: AdminRefundsQueryDto,
  ): Promise<{ items: RefundResponseDto[]; total: number }> {
    const where: Prisma.RefundWhereInput = { status: query.status };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.refund.findMany({
        where,
        include: RESPONSE_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.refund.count({ where }),
    ]);
    return { items: rows.map(toRefundResponse), total };
  }

  private async toResponse(refundId: string): Promise<RefundResponseDto> {
    return toRefundResponse(
      await this.prisma.refund.findUniqueOrThrow({
        where: { id: refundId },
        include: RESPONSE_INCLUDE,
      }),
    );
  }
}

const RESPONSE_INCLUDE = {
  payment: {
    select: {
      reference: true,
      status: true,
      amountMinor: true,
      booking: { select: { reference: true } },
      refunds: { select: { status: true, amountMinor: true } },
    },
  },
} as const satisfies Prisma.RefundInclude;

function toRefundResponse(
  refund: Prisma.RefundGetPayload<{ include: typeof RESPONSE_INCLUDE }>,
): RefundResponseDto {
  return {
    reference: refund.reference,
    amountMinor: minorToNumber(refund.amountMinor),
    currency: refund.currency,
    status: refund.status,
    createdAt: refund.createdAt.toISOString(),
    updatedAt: refund.updatedAt.toISOString(),
    paymentReference: refund.payment.reference,
    bookingReference: refund.payment.booking.reference,
    reason: refund.reason,
    paymentStatus: refund.payment.status,
    refundableMinor: minorToNumber(
      refundableRemainderMinor(
        refund.payment.amountMinor,
        refund.payment.refunds,
      ),
    ),
  };
}

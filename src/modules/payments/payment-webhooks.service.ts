import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Redis } from 'ioredis';
import { AppException } from '../../common/errors/app.exception.js';
import { minorToNumber } from '../../common/money.js';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  PaymentReviewReason,
  PaymentStatus,
} from '../../generated/prisma/enums.js';
import {
  type GatewayPayment,
  PaymentGatewayError,
  PaymentGatewayProvider,
  type WebhookEvent,
} from '../../integrations/payment/payment-gateway.provider.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { REDIS } from '../../redis/redis.module.js';
import { AuditService } from '../audit/audit.service.js';
import { PAYMENT_IN_PROGRESS_MAX_AGE_HOURS } from '../bookings/payment-in-progress.js';
import {
  BookingsService,
  type PayableBookingRow,
} from '../bookings/bookings.service.js';
import { NotificationEventsService } from '../notifications/events/notification-events.service.js';
import type { WebhookAckResponseDto } from './dto/webhook-ack-response.dto.js';
import {
  bookingPaymentStatusAfterSuccess,
  isDuplicateCapture,
  nextPaymentStatus,
  outcomeOfGatewayStatus,
  providerOf,
  reviewOnSuccess,
  storedEventPayload,
} from './payment-rules.js';
import { RefundsService } from './refunds.service.js';

/** Refusals are logged at most once per this window. */
export const REFUSAL_LOG_WINDOW_MS = 60_000;

/**
 * The status sweep asks the gateway about a payment still open this long
 * after its last change: long enough for the checkout and its notice.
 */
export const PAYMENT_SWEEP_AFTER_MINUTES = 15;
/**
 * ...and stops asking about an order nobody paid after this long; the
 * booking hold-expiry job waits for a pending payment as long.
 */
export const PAYMENT_SWEEP_MAX_AGE_HOURS = PAYMENT_IN_PROGRESS_MAX_AGE_HOURS;
const SWEEP_LOCK_KEY = 'payments:sweep:lock';
const SWEEP_LOCK_SECONDS = 5 * 60;
const SWEEP_BATCH = 100;
const RELEASE_LOCK = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/**
 * What applied an outcome, kept in its audit record. `checkout-fetch`: the
 * gateway's own status, asked right after a verified checkout result.
 */
type OutcomeSource =
  'webhook' | 'webhook-redelivery' | 'sweep' | 'checkout-fetch';

/** Events that move a payment; the others are stored only. */
const OUTCOME = {
  'payment.captured': PaymentStatus.SUCCEEDED,
  'payment.failed': PaymentStatus.FAILED,
} as const;

/**
 * Receives gateway notifications (M9). The signature over the exact bytes
 * is checked before anything is read; a forged or unsigned call is refused
 * and stored nowhere. A verified event is stored in `PaymentEvent` (unique
 * per provider event ID) and applied in the same transaction, before the
 * acknowledgement: a duplicate delivery inserts nothing and changes nothing
 * (rule 5), except that a notice stored before its order was known is
 * applied when it comes again (`apply`). Outcomes only move a payment forward (`nextPaymentStatus`), so a
 * delayed or out-of-order notice is safe. A payment writes the booking's
 * payment summary; the booking becomes `CONFIRMED` only when the
 * confirmation rule then holds (`BookingsService.recordPaymentStatus`):
 * a payment alone never confirms it (rule 2). A notice that never
 * arrives is made up for by the status sweep (`runSweep`).
 */
@Injectable()
export class PaymentWebhooksService {
  private readonly logger = new Logger(PaymentWebhooksService.name);
  /** When the last refusal warning was written, and refusals since then. */
  private lastWarnedAt = -Infinity;
  private unlogged = 0;

  constructor(
    private readonly gateway: PaymentGatewayProvider,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly bookings: BookingsService,
    private readonly refunds: RefundsService,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly events: NotificationEventsService,
  ) {}

  async receive(
    provider: string,
    rawBody: unknown,
    headers: IncomingHttpHeaders,
  ): Promise<WebhookAckResponseDto> {
    if (provider !== this.gateway.name) throw new NotFoundException();

    // Without the raw bytes the signature cannot be checked; never verify a
    // re-serialised body.
    const result = Buffer.isBuffer(rawBody)
      ? this.gateway.parseWebhook(rawBody, headers)
      : ({ ok: false, reason: 'signature' } as const);

    if (!result.ok) {
      this.warnRefused(provider, result.reason);
      if (result.reason === 'signature') {
        throw new AppException(
          'WEBHOOK_SIGNATURE_INVALID',
          'The webhook signature is not valid.',
          HttpStatus.BAD_REQUEST,
        );
      }
      throw new AppException(
        'VALIDATION_ERROR',
        'The webhook is not a well-formed event.',
        HttpStatus.BAD_REQUEST,
      );
    }
    await this.prisma.$transaction((tx) => this.apply(tx, result.event));
    return { received: true };
  }

  /**
   * Stores the event once and applies it. The booking is locked before the
   * payment is read, as on every payment write, so two notices for one
   * booking (or a notice and a cancellation) are applied one after the
   * other. An event for an order we do not know yet (the notice can beat the
   * transaction that records the order) is stored unapplied (`paymentId`
   * and `processedAt` empty) and still acknowledged, never a 5xx: a gateway
   * disables a failing webhook.
   *
   * A redelivery inserts nothing. If the stored event was linked to a
   * payment it was applied then, and nothing more happens. If it was stored
   * unapplied and its order is known now, it is applied now. The event row
   * is append-only, so it stays unlinked: the application is recorded on the
   * payment and in its audit record (with the event id). The replay guard is
   * therefore the payment's own state, not the event id alone: a status only
   * moves forward, and the same capture reported again changes nothing.
   */
  private async apply(
    tx: Prisma.TransactionClient,
    event: WebhookEvent,
  ): Promise<void> {
    const provider = providerOf(this.gateway);
    if (event.type === 'refund.processed' || event.type === 'refund.failed') {
      await this.applyRefund(tx, event);
      return;
    }
    const outcome =
      event.type === 'payment.captured' || event.type === 'payment.failed'
        ? OUTCOME[event.type]
        : null;
    const found =
      outcome && event.providerOrderId
        ? await tx.payment.findUnique({
            where: {
              provider_providerOrderId: {
                provider,
                providerOrderId: event.providerOrderId,
              },
            },
            select: { id: true, bookingId: true },
          })
        : null;
    const booking = found
      ? await this.bookings.forPayment({ id: found.bookingId }, tx)
      : null;

    // References and amounts only: an allowlist of the parsed event, never
    // the raw body, which can carry card and contact details (rule 10).
    const { count } = await tx.paymentEvent.createMany({
      data: {
        paymentId: found?.id ?? null,
        provider,
        providerEventId: event.providerEventId,
        type: event.type,
        payload: storedEventPayload(event),
        signatureValid: true,
        processedAt: found ? new Date() : null,
      },
      skipDuplicates: true,
    });
    if (!found || !booking || !outcome) return;
    let source: OutcomeSource = 'webhook';
    if (count === 0) {
      const stored = await tx.paymentEvent.findUnique({
        where: {
          provider_providerEventId: {
            provider,
            providerEventId: event.providerEventId,
          },
        },
        select: { paymentId: true, type: true },
      });
      // Applied when it was first stored: never twice.
      if (!stored || stored.paymentId !== null || stored.type !== event.type) {
        return;
      }
      source = 'webhook-redelivery';
    }
    await this.applyOutcome(tx, found.id, booking, outcome, event, {
      source,
      providerEventId: event.providerEventId,
    });
  }

  /**
   * A refund notice (W4-1): stored once like any event, linked to the
   * refund's payment when the refund is known, and applied by
   * `RefundsService.applyNotice`, which moves a refund only out of
   * `REQUESTED` or `PENDING`. The guard is the refund's natural key and
   * state, not the event id alone: the same refund reported again under a
   * new event id changes nothing. A notice for a refund we do not know (made
   * outside Flyviman) is stored unapplied and applied if it comes again
   * once its refund is known.
   */
  private async applyRefund(
    tx: Prisma.TransactionClient,
    event: WebhookEvent,
  ): Promise<void> {
    const provider = providerOf(this.gateway);
    const stored = await tx.paymentEvent.findUnique({
      where: {
        provider_providerEventId: {
          provider,
          providerEventId: event.providerEventId,
        },
      },
      select: { paymentId: true, type: true },
    });
    // Applied when it was first stored: never twice.
    if (stored && (stored.paymentId !== null || stored.type !== event.type)) {
      return;
    }
    const paymentId = await this.refunds.applyNotice(
      tx,
      event,
      stored ? 'webhook-redelivery' : 'webhook',
    );
    if (stored) return;
    await tx.paymentEvent.createMany({
      data: {
        paymentId,
        provider,
        providerEventId: event.providerEventId,
        type: event.type,
        payload: storedEventPayload(event),
        signatureValid: true,
        processedAt: paymentId ? new Date() : null,
      },
      skipDuplicates: true,
    });
  }

  /**
   * Applies a verified outcome to a payment whose booking `tx` has locked.
   * A second capture on a paid order is flagged, never applied; a success
   * for another amount is flagged, never a success; otherwise the status
   * only moves forward. A payment writes the booking's payment summary
   * only, never its status (rule 2). Whether anything changed.
   */
  private async applyOutcome(
    tx: Prisma.TransactionClient,
    paymentId: string,
    booking: PayableBookingRow,
    outcome: 'SUCCEEDED' | 'FAILED',
    report: Pick<
      WebhookEvent,
      'providerPaymentId' | 'amountMinor' | 'currency' | 'method'
    >,
    origin: { source: OutcomeSource; providerEventId?: string },
  ): Promise<boolean> {
    const payment = await tx.payment.findUniqueOrThrow({
      where: { id: paymentId },
    });
    const before = { reference: payment.reference, status: payment.status };

    if (
      outcome === PaymentStatus.SUCCEEDED &&
      isDuplicateCapture(payment, report.providerPaymentId)
    ) {
      // Money moved twice. The first reason found is kept; each capture is
      // recorded once (by its gateway payment), so none goes unrecorded.
      await this.flag(
        tx,
        payment,
        PaymentReviewReason.DUPLICATE_CAPTURE,
        {
          ...origin,
          reportedProviderPaymentId: report.providerPaymentId ?? null,
          providerPaymentId: payment.providerPaymentId,
        },
        report.providerPaymentId
          ? { reportedProviderPaymentId: report.providerPaymentId }
          : {},
      );
      return true;
    }

    if (
      outcome === PaymentStatus.SUCCEEDED &&
      (report.amountMinor === undefined ||
        BigInt(report.amountMinor) !== payment.amountMinor ||
        report.currency !== payment.currency)
    ) {
      // Never a success for an amount other than the order's. Recorded once
      // per payment (rule 6, `flag`); the sweep, which asks again every
      // run, and the check after each repeated checkout result record
      // nothing more once the payment is flagged.
      if (
        payment.reviewReason !== null &&
        (origin.source === 'sweep' || origin.source === 'checkout-fetch')
      ) {
        return false;
      }
      await this.flag(tx, payment, PaymentReviewReason.AMOUNT_MISMATCH, {
        ...origin,
        reportedAmountMinor: report.amountMinor ?? null,
        reportedCurrency: report.currency ?? null,
        amountMinor: minorToNumber(payment.amountMinor),
      });
      return true;
    }

    const next = nextPaymentStatus(payment.status, outcome);
    // Older than what is recorded (a failure after a success, a repeat).
    if (!next) return false;

    if (next === PaymentStatus.FAILED) {
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: next,
          providerPaymentId:
            payment.providerPaymentId ?? report.providerPaymentId,
        },
      });
      await this.audit.record(
        {
          action: 'payment.status',
          entityType: 'Payment',
          entityId: payment.id,
          before,
          after: { reference: payment.reference, status: next, ...origin },
          actor: null,
        },
        tx,
      );
      await this.events.notifyBooking(tx, 'payment.failed', booking.id);
      return true;
    }

    // A success is always recorded: money moved. If the booking is closed
    // or already paid, operations are told through `reviewReason`, and the
    // payment is listed in the finance refunds-due queue.
    const reviewReason = reviewOnSuccess(booking, payment.purpose);
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: next,
        providerPaymentId: report.providerPaymentId,
        paidAt: new Date(),
        reviewReason: payment.reviewReason ?? reviewReason,
        // The method type only, for the receipt (rule 10).
        method: report.method ?? payment.method,
      },
    });
    await this.audit.record(
      {
        action: 'payment.status',
        entityType: 'Payment',
        entityId: payment.id,
        before,
        after: {
          reference: payment.reference,
          status: next,
          bookingStatus: booking.status,
          reviewReason,
          ...origin,
        },
        actor: null,
      },
      tx,
    );
    const summary = bookingPaymentStatusAfterSuccess(
      booking.paymentStatus,
      payment.purpose,
    );
    if (summary) {
      const confirmation = await this.bookings.recordPaymentStatus(
        tx,
        booking,
        summary,
        { reference: payment.reference, purpose: payment.purpose },
      );
      // Money for a trip that can no longer be flown as booked (the held
      // time taken, the aircraft or operator no longer bookable, departed)
      // is never stranded: flagged as for a closed booking, it is listed in
      // full in the finance refunds-due queue (W5-9d, rules 3 and 4). The
      // booking stays `AWAITING_PAYMENT` and paid for operations.
      if (!confirmation.confirmed && confirmation.unbookable) {
        await this.flag(
          tx,
          {
            id: payment.id,
            reference: payment.reference,
            status: next,
            reviewReason: payment.reviewReason ?? reviewReason,
          },
          PaymentReviewReason.BOOKING_CLOSED,
          { ...origin, confirmationBlocked: confirmation.reason },
        );
      }
    }
    await this.events.notifyBooking(tx, 'payment.succeeded', booking.id);
    return true;
  }

  /**
   * Sets `reviewReason` if none is set yet (one reason is kept: the first)
   * and writes the audit record. Gateway references and amounts only. The
   * flag that sets the reason is always recorded; any other is recorded
   * once per payment and reason (and `once`, the reported fact that makes
   * it new): a notice stored before its order was known stays unlinked and
   * is applied again on every redelivery (W5-9d).
   */
  private async flag(
    tx: Prisma.TransactionClient,
    payment: {
      id: string;
      reference: string;
      status: PaymentStatus;
      reviewReason: PaymentReviewReason | null;
    },
    reason: PaymentReviewReason,
    details: Record<string, string | number | null>,
    once: Record<string, string> = {},
  ): Promise<void> {
    const before = {
      reference: payment.reference,
      status: payment.status,
      reviewReason: payment.reviewReason,
    };
    if (payment.reviewReason === null) {
      await tx.payment.update({
        where: { id: payment.id },
        data: { reviewReason: reason },
      });
    } else if (
      await this.audit.exists(
        {
          action: 'payment.flag',
          entityType: 'Payment',
          entityId: payment.id,
          after: { flagged: reason, ...once },
        },
        tx,
      )
    ) {
      return;
    }
    await this.audit.record(
      {
        action: 'payment.flag',
        entityType: 'Payment',
        entityId: payment.id,
        before,
        after: {
          reference: payment.reference,
          status: payment.status,
          reviewReason: payment.reviewReason ?? reason,
          flagged: reason,
          ...details,
        },
        actor: null,
      },
      tx,
    );
  }

  // --- Status sweep --------------------------------------------------------

  /** Every five minutes. */
  @Cron('*/5 * * * *', { name: 'payment-sweep' })
  async scheduled(): Promise<void> {
    try {
      await this.runSweep();
    } catch (error) {
      this.logger.error(
        `Payment sweep failed: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
    }
  }

  /**
   * For a notice that never arrived, or arrived before its order was
   * recorded and was not sent again: asks the gateway for the status of
   * every payment still `INITIATED` or `PENDING` after
   * `PAYMENT_SWEEP_AFTER_MINUTES` (and younger than
   * `PAYMENT_SWEEP_MAX_AGE_HOURS`, so an order nobody paid is not asked
   * about forever), and applies a final status the gateway reports for that
   * order, as a notice would be. The gateway payments asked about are the
   * one the checkout reported and those named by notices stored unapplied
   * for the order; for a payment with neither, the payments the gateway
   * lists for the order (`fetchOrderPayments`, W4-1). The gateway is
   * called outside any transaction. One instance at a time (Redis lock).
   */
  async runSweep(now = new Date()): Promise<{
    checked: number;
    applied: number;
    skipped: boolean;
  }> {
    const token = randomUUID();
    const locked = await this.redis.set(
      SWEEP_LOCK_KEY,
      token,
      'EX',
      SWEEP_LOCK_SECONDS,
      'NX',
    );
    if (!locked) return { checked: 0, applied: 0, skipped: true };
    let checked = 0;
    let applied = 0;
    try {
      const provider = providerOf(this.gateway);
      const seen: string[] = [];
      for (;;) {
        const due = await this.prisma.payment.findMany({
          where: {
            id: { notIn: seen },
            provider,
            status: { in: [PaymentStatus.INITIATED, PaymentStatus.PENDING] },
            providerOrderId: { not: null },
            updatedAt: {
              lte: new Date(
                now.getTime() - PAYMENT_SWEEP_AFTER_MINUTES * 60_000,
              ),
            },
            createdAt: {
              gte: new Date(
                now.getTime() - PAYMENT_SWEEP_MAX_AGE_HOURS * 3_600_000,
              ),
            },
          },
          select: {
            id: true,
            bookingId: true,
            providerOrderId: true,
            providerPaymentId: true,
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: SWEEP_BATCH,
        });
        for (const payment of due) {
          seen.push(payment.id);
          checked += 1;
          try {
            if (await this.sweepOne(payment)) applied += 1;
          } catch (error) {
            // One payment never stops the rest; only the error's name.
            this.logger.error(
              `Payment sweep skipped a payment: ${error instanceof Error ? error.name : 'unknown error'}`,
            );
          }
        }
        if (due.length < SWEEP_BATCH) break;
      }
      if (applied > 0) {
        this.logger.log(`Payment sweep: ${applied} of ${checked} settled`);
      }
      return { checked, applied, skipped: false };
    } finally {
      await this.redis.eval(RELEASE_LOCK, 1, SWEEP_LOCK_KEY, token);
    }
  }

  /**
   * Asks the gateway about one payment right after its checkout result was
   * verified, and applies what the gateway itself reports, exactly as the
   * sweep does (`sweepOne`, `applyOutcome`: under the booking's lock, only
   * forward, a duplicate capture flagged). The browser's word alone never
   * settles a payment (rule 2), and a webhook or sweep that applies the same
   * outcome changes nothing more (rule 5). `captured` makes it `SUCCEEDED`,
   * `failed` `FAILED`; anything else (`authorized` while capture is pending,
   * `created`) or a gateway that cannot be asked leaves it `PENDING` for the
   * notice or the sweep. `checkoutPaymentId`, the signed result's payment,
   * is asked about too: after a failed attempt the customer can pay again
   * in the same order. Never throws: the checkout result is already
   * recorded. Whether the payment changed.
   */
  async settleFromGateway(
    paymentId: string,
    checkoutPaymentId: string,
  ): Promise<boolean> {
    try {
      const payment = await this.prisma.payment.findUnique({
        where: { id: paymentId },
        select: {
          id: true,
          bookingId: true,
          providerOrderId: true,
          providerPaymentId: true,
        },
      });
      return payment
        ? await this.sweepOne(payment, 'checkout-fetch', checkoutPaymentId)
        : false;
    } catch (error) {
      // Only the error's name: the payment is settled later.
      this.logger.error(
        `Payment check after checkout failed: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
      return false;
    }
  }

  private async sweepOne(
    payment: {
      id: string;
      bookingId: string;
      providerOrderId: string | null;
      providerPaymentId: string | null;
    },
    source: OutcomeSource = 'sweep',
    reportedPaymentId?: string,
  ): Promise<boolean> {
    const orderId = payment.providerOrderId;
    if (!orderId) return false;
    const early = await this.prisma.paymentEvent.findMany({
      where: {
        paymentId: null,
        provider: providerOf(this.gateway),
        type: { in: Object.keys(OUTCOME) },
        payload: { path: ['providerOrderId'], equals: orderId },
      },
      select: { payload: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const candidates = new Set<string>();
    if (payment.providerPaymentId) candidates.add(payment.providerPaymentId);
    if (reportedPaymentId) candidates.add(reportedPaymentId);
    for (const { payload } of early) {
      const id = (payload as { providerPaymentId?: unknown } | null)
        ?.providerPaymentId;
      if (typeof id === 'string') candidates.add(id);
    }
    // No gateway payment id reached us (the checkout result and the notice
    // were both lost): ask the gateway for the payments on the order.
    if (candidates.size === 0) {
      try {
        for (const attempt of await this.gateway.fetchOrderPayments(orderId)) {
          candidates.add(attempt.providerPaymentId);
        }
      } catch (error) {
        // Unknown to the gateway, or it is down: asked again next run.
        if (error instanceof PaymentGatewayError) return false;
        throw error;
      }
    }

    let changed = false;
    for (const candidate of candidates) {
      let fetched: GatewayPayment;
      try {
        fetched = await this.gateway.fetchPayment(candidate);
      } catch (error) {
        // Unknown to the gateway, or it is down: asked again next run.
        if (error instanceof PaymentGatewayError) continue;
        throw error;
      }
      const outcome = outcomeOfGatewayStatus(fetched.status);
      // Only the gateway's own answer for this order settles it.
      if (!outcome || fetched.providerOrderId !== orderId) continue;
      const done = await this.prisma.$transaction(async (tx) => {
        const booking = await this.bookings.forPayment(
          { id: payment.bookingId },
          tx,
        );
        if (!booking) return false;
        return this.applyOutcome(tx, payment.id, booking, outcome, fetched, {
          source,
        });
      });
      changed ||= done;
    }
    return changed;
  }

  /**
   * One warning a minute at most, with the count of refusals since the last
   * one, so a flood of forged calls cannot flood the log. Never the payload
   * or the signature itself.
   */
  private warnRefused(provider: string, reason: string): void {
    this.unlogged += 1;
    const now = Date.now();
    if (now - this.lastWarnedAt < REFUSAL_LOG_WINDOW_MS) return;
    this.logger.warn(
      `Payment webhook refused (provider=${provider}, reason=${reason}, refusals=${this.unlogged})`,
    );
    this.lastWarnedAt = now;
    this.unlogged = 0;
  }
}

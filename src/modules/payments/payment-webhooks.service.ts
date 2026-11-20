import {
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { IncomingHttpHeaders } from 'node:http';
import { AppException } from '../../common/errors/app.exception.js';
import { minorToNumber } from '../../common/money.js';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  PaymentReviewReason,
  PaymentStatus,
} from '../../generated/prisma/enums.js';
import {
  PaymentGatewayProvider,
  type WebhookEvent,
} from '../../integrations/payment/payment-gateway.provider.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { BookingsService } from '../bookings/bookings.service.js';
import { NotificationEventsService } from '../notifications/events/notification-events.service.js';
import type { WebhookAckResponseDto } from './dto/webhook-ack-response.dto.js';
import {
  bookingPaymentStatusAfterSuccess,
  nextPaymentStatus,
  reviewOnSuccess,
} from './payment-rules.js';
import { providerOf } from './payments.service.js';

/** Refusals are logged at most once per this window. */
export const REFUSAL_LOG_WINDOW_MS = 60_000;

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
 * (rule 5). Outcomes only move a payment forward (`nextPaymentStatus`), so a
 * delayed or out-of-order notice is safe. A payment writes the booking's
 * payment summary only, never its status (rule 2).
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
   * other. An event for an order we do not know is stored unapplied
   * (`paymentId` and `processedAt` empty) and still acknowledged, so the
   * gateway stops resending it.
   */
  private async apply(
    tx: Prisma.TransactionClient,
    event: WebhookEvent,
  ): Promise<void> {
    const provider = providerOf(this.gateway);
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

    // References and amounts only: the parsed event, never the raw body,
    // which can carry card and contact details (rule 10).
    const { count } = await tx.paymentEvent.createMany({
      data: {
        paymentId: found?.id ?? null,
        provider,
        providerEventId: event.providerEventId,
        type: event.type,
        payload: event as unknown as Prisma.InputJsonValue,
        signatureValid: true,
        processedAt: found ? new Date() : null,
      },
      skipDuplicates: true,
    });
    // Seen before: acknowledged, never applied twice.
    if (count === 0 || !found || !booking || !outcome) return;

    const payment = await tx.payment.findUniqueOrThrow({
      where: { id: found.id },
    });
    const before = { reference: payment.reference, status: payment.status };

    if (
      outcome === PaymentStatus.SUCCEEDED &&
      (event.amountMinor === undefined ||
        BigInt(event.amountMinor) !== payment.amountMinor ||
        event.currency !== payment.currency)
    ) {
      // Never a success for an amount other than the order's.
      if (payment.reviewReason === null) {
        await tx.payment.update({
          where: { id: payment.id },
          data: { reviewReason: PaymentReviewReason.AMOUNT_MISMATCH },
        });
        await this.audit.record(
          {
            action: 'payment.flag',
            entityType: 'Payment',
            entityId: payment.id,
            before,
            after: {
              ...before,
              reviewReason: PaymentReviewReason.AMOUNT_MISMATCH,
              reportedAmountMinor: event.amountMinor ?? null,
              reportedCurrency: event.currency ?? null,
              amountMinor: minorToNumber(payment.amountMinor),
            },
            actor: null,
          },
          tx,
        );
      }
      return;
    }

    const next = nextPaymentStatus(payment.status, outcome);
    // Older than what is recorded (a failure after a success, a repeat).
    if (!next) return;

    if (next === PaymentStatus.FAILED) {
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: next,
          providerPaymentId:
            payment.providerPaymentId ?? event.providerPaymentId,
        },
      });
      await this.audit.record(
        {
          action: 'payment.status',
          entityType: 'Payment',
          entityId: payment.id,
          before,
          after: { reference: payment.reference, status: next },
          actor: null,
        },
        tx,
      );
      await this.events.notifyBooking(tx, 'payment.failed', booking.id);
      return;
    }

    // A success is always recorded: money moved. If the booking is closed
    // or already paid, operations are told through `reviewReason` (the
    // refund follows in W4-1).
    const reviewReason = reviewOnSuccess(booking);
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: next,
        providerPaymentId: event.providerPaymentId,
        paidAt: new Date(),
        reviewReason: payment.reviewReason ?? reviewReason,
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
      await this.bookings.recordPaymentStatus(tx, booking, summary, {
        reference: payment.reference,
        purpose: payment.purpose,
      });
    }
    await this.events.notifyBooking(tx, 'payment.succeeded', booking.id);
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

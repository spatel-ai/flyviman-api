import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException } from '../../common/errors/app.exception.js';
import {
  type IdempotencyClaim,
  markIdempotencyCommitted,
} from '../../common/idempotency/idempotency.store.js';
import { minorToNumber } from '../../common/money.js';
import { paymentReference } from '../../common/reference.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PaymentStatus, PriceType } from '../../generated/prisma/enums.js';
import {
  PaymentGatewayError,
  PaymentGatewayProvider,
} from '../../integrations/payment/payment-gateway.provider.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { parseItinerary } from '../bookings/booking-json.js';
import {
  BookingsService,
  type PayableBookingRow,
} from '../bookings/bookings.service.js';
import { depositPercentFor } from '../bookings/deposit-percent.js';
import { readCreditedMinor } from '../bookings/paid-amount.js';
import { CategoryConfigService } from '../configuration/category-config.service.js';
import type {
  CreatePaymentDto,
  PaymentResponseDto,
  VerifyPaymentDto,
} from './dto/payment.dto.js';
import { PaymentWebhooksService } from './payment-webhooks.service.js';
import {
  amountDue,
  nextPaymentStatus,
  overOnlineLimit,
  providerOf,
} from './payment-rules.js';

/** Attempts at a fresh reference before giving up (31^6 codes). */
const REFERENCE_ATTEMPTS = 5;

/** A payment the customer may still complete: its order is reused. */
const OPEN: PaymentStatus[] = [PaymentStatus.INITIATED, PaymentStatus.PENDING];

const PAYMENT_FIELDS = {
  id: true,
  reference: true,
  bookingId: true,
  providerOrderId: true,
  providerPaymentId: true,
  purpose: true,
  amountMinor: true,
  currency: true,
  status: true,
  paidAt: true,
  createdAt: true,
} as const;

type PaymentRow = Prisma.PaymentGetPayload<{ select: typeof PAYMENT_FIELDS }>;

function notFound(what: 'Booking' | 'Payment'): AppException {
  return new AppException(
    'NOT_FOUND',
    `${what} not found.`,
    HttpStatus.NOT_FOUND,
  );
}

function providerError(): AppException {
  return new AppException(
    'PAYMENT_PROVIDER_ERROR',
    'The payment gateway could not take the payment now. Try again shortly.',
    HttpStatus.BAD_GATEWAY,
  );
}

/**
 * 422: above the online payment limit, ours (`PAYMENT_MAX_ORDER_MINOR`) or
 * the gateway account's. No details: the limit is an account setting.
 * Retrying cannot help; the customer is pointed to another way to pay.
 */
function overLimitError(): AppException {
  return new AppException(
    'PAYMENT_AMOUNT_OVER_LIMIT',
    'This amount is above the limit for online payment.',
    HttpStatus.UNPROCESSABLE_ENTITY,
  );
}

/** A refused gateway order, as the customer's answer. */
export function gatewayRefusal(error: PaymentGatewayError): AppException {
  return error.reason === 'AMOUNT_OVER_LIMIT'
    ? overLimitError()
    : providerError();
}

/**
 * Customer payments (M9): an order for what a booking owes now, and the
 * checkout result. Neither ever makes a payment `SUCCEEDED` (only a verified
 * gateway notice does, `PaymentWebhooksService`), and nothing here changes a
 * booking's status (rule 2). Every write locks the booking first
 * (`BookingsService.forPayment`).
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly bookings: BookingsService,
    private readonly categories: CategoryConfigService,
    private readonly gateway: PaymentGatewayProvider,
    private readonly webhooks: PaymentWebhooksService,
    private readonly config: ConfigService,
  ) {}

  /**
   * A gateway order for the amount due now (`payment-rules.ts`). One open
   * payment per booking: while one is `INITIATED` or `PENDING` for the same
   * purpose and amount it is returned again, so two tabs never make two
   * orders. The gateway is called before the transaction; the transaction
   * re-checks under the booking's lock and records the payment with the
   * idempotency key, so a lost race leaves only an unpaid gateway order.
   */
  async createOrder(
    user: AuthUser,
    bookingReference: string,
    input: CreatePaymentDto,
    claim: IdempotencyClaim,
    idempotencyKey: string,
  ): Promise<PaymentResponseDto> {
    const booking = await this.bookings.forPayment({
      reference: bookingReference,
      customerId: user.id,
    });
    if (!booking) throw notFound('Booking');
    const due = await this.due(this.prisma, booking, input);
    if (
      overOnlineLimit(
        due.amountMinor,
        this.config.get<number>('PAYMENT_MAX_ORDER_MINOR'),
      )
    ) {
      throw overLimitError();
    }
    const open = await this.openPayment(this.prisma, booking.id, due);
    if (open) return this.toResponse(open, booking.reference);

    let order: { providerOrderId: string };
    try {
      order = await this.gateway.createOrder({
        amountMinor: minorToNumber(due.amountMinor),
        currency: booking.currency,
        receipt: booking.reference,
      });
    } catch (error) {
      if (error instanceof PaymentGatewayError) throw gatewayRefusal(error);
      throw error;
    }

    // Globally unique: the header key is unique only per caller.
    const storedKey = `${user.id}:${idempotencyKey.toLowerCase()}`;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          await markIdempotencyCommitted(tx, claim);
          const locked = await this.bookings.forPayment({ id: booking.id }, tx);
          if (!locked) throw notFound('Booking');
          const now = await this.due(tx, locked, input);
          const again = await this.openPayment(tx, locked.id, now);
          if (again) return this.toResponse(again, locked.reference);
          const reused = await tx.payment.findUnique({
            where: { idempotencyKey: storedKey },
            select: { id: true },
          });
          if (reused) {
            throw new AppException(
              'IDEMPOTENCY_CONFLICT',
              'This Idempotency-Key was already used for another payment.',
              HttpStatus.CONFLICT,
            );
          }
          const payment = await tx.payment.create({
            data: {
              reference: paymentReference(),
              bookingId: locked.id,
              provider: providerOf(this.gateway),
              providerOrderId: order.providerOrderId,
              purpose: now.purpose,
              amountMinor: now.amountMinor,
              currency: locked.currency,
              status: PaymentStatus.INITIATED,
              idempotencyKey: storedKey,
            },
            select: PAYMENT_FIELDS,
          });
          await this.audit.record(
            {
              action: 'payment.create',
              entityType: 'Payment',
              entityId: payment.id,
              after: {
                reference: payment.reference,
                bookingReference: locked.reference,
                purpose: payment.purpose,
                amountMinor: minorToNumber(payment.amountMinor),
                currency: payment.currency,
                status: payment.status,
                providerOrderId: payment.providerOrderId,
              },
            },
            tx,
          );
          return this.toResponse(payment, locked.reference);
        });
      } catch (error) {
        const clash =
          (error as { code?: unknown }).code === 'P2002' &&
          attempt < REFERENCE_ATTEMPTS;
        if (!clash) throw error;
      }
    }
  }

  /**
   * The checkout result the browser reports. Its signature is checked
   * through the gateway, and the browser's word is still not final: a valid
   * one makes the payment `PENDING` at most (state-machines.md, Payment).
   * Then the server asks the gateway for the payment itself and applies what
   * the gateway reports, as the sweep does
   * (`PaymentWebhooksService.settleFromGateway`): `SUCCEEDED` or `FAILED`
   * at once, without waiting for the notice; otherwise (`authorized`, the
   * gateway unreachable) it stays `PENDING` for the notice or the sweep.
   * While it waits, the booking's hold on the aircraft is kept, for 48 hours
   * from the order at most (`keepHoldForPayment`, W5-9d). Someone else's
   * payment is 404; a result for another order or with a bad signature is
   * 400 `PAYMENT_SIGNATURE_INVALID`.
   */
  async verify(
    user: AuthUser,
    reference: string,
    input: VerifyPaymentDto,
  ): Promise<PaymentResponseDto> {
    const recorded = await this.recordCheckout(user, reference, input);
    // FAILED too: after a failed attempt the customer can pay again in the
    // same order, and only the gateway says whether that payment went through.
    const open =
      recorded.payment.status === PaymentStatus.PENDING ||
      recorded.payment.status === PaymentStatus.FAILED;
    if (
      !open ||
      !(await this.webhooks.settleFromGateway(
        recorded.payment.id,
        input.providerPaymentId,
      ))
    ) {
      return this.toResponse(recorded.payment, recorded.bookingReference);
    }
    const settled = await this.prisma.payment.findUniqueOrThrow({
      where: { id: recorded.payment.id },
      select: PAYMENT_FIELDS,
    });
    return this.toResponse(settled, recorded.bookingReference);
  }

  /** The signed checkout result recorded: the payment `PENDING` at most. */
  private async recordCheckout(
    user: AuthUser,
    reference: string,
    input: VerifyPaymentDto,
  ): Promise<{ payment: PaymentRow; bookingReference: string }> {
    const found = await this.prisma.payment.findFirst({
      where: { reference, booking: { customerId: user.id } },
      select: { id: true, bookingId: true, providerOrderId: true },
    });
    if (!found) throw notFound('Payment');
    if (
      found.providerOrderId !== input.providerOrderId ||
      !this.gateway.verifyCheckoutSignature(input)
    ) {
      throw new AppException(
        'PAYMENT_SIGNATURE_INVALID',
        'The payment result could not be verified.',
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.prisma.$transaction(async (tx) => {
      const booking = await this.bookings.forPayment(
        { id: found.bookingId },
        tx,
      );
      if (!booking) throw notFound('Payment');
      const payment = await tx.payment.findUniqueOrThrow({
        where: { id: found.id },
        select: PAYMENT_FIELDS,
      });
      const next = nextPaymentStatus(payment.status, PaymentStatus.PENDING);
      if (!next) return { payment, bookingReference: booking.reference };
      const updated = await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: next,
          providerPaymentId:
            payment.providerPaymentId ?? input.providerPaymentId,
        },
        select: PAYMENT_FIELDS,
      });
      await this.audit.record(
        {
          action: 'payment.status',
          entityType: 'Payment',
          entityId: payment.id,
          before: { reference: payment.reference, status: payment.status },
          after: {
            reference: payment.reference,
            status: next,
            source: 'checkout',
          },
        },
        tx,
      );
      await this.bookings.keepHoldForPayment(tx, booking, payment.createdAt);
      return { payment: updated, bookingReference: booking.reference };
    });
  }

  /**
   * What is due now (the first payment, or a Model C balance), or the refusal: 409 `PAYMENT_ALREADY_PAID`, 409
   * `PAYMENT_NOT_DUE`, or 409 `PAYMENT_AMOUNT_MISMATCH` when the customer
   * was shown another amount (the amount due is in `details`).
   */
  private async due(
    db: Pick<Prisma.TransactionClient, 'payment'>,
    booking: PayableBookingRow,
    input: CreatePaymentDto,
  ) {
    const depositPercent = await depositPercentFor(
      booking,
      async () =>
        (await this.categories.resolve(booking.category)).depositPercent,
    );
    const due = amountDue(
      {
        status: booking.status,
        priceType: booking.priceType,
        paymentModel: booking.paymentModel,
        operatorAccepted: booking.operatorAcceptedAt !== null,
        paymentStatus: booking.paymentStatus,
        totalMinor: booking.totalMinor,
        creditedMinor: await readCreditedMinor(db, booking.id),
        departureAt: new Date(
          parseItinerary(booking.itinerary).legs[0].departureAt,
        ),
      },
      depositPercent,
      new Date(),
    );
    if (!due.due) {
      throw new AppException(
        due.code,
        due.code === 'PAYMENT_ALREADY_PAID'
          ? 'This booking has already been paid.'
          : 'This booking has nothing to pay now.',
        HttpStatus.CONFLICT,
        [{ field: 'booking', issue: due.reason }],
      );
    }
    if (
      BigInt(input.expectedAmountMinor) !== due.amountMinor ||
      input.currency !== booking.currency
    ) {
      throw new AppException(
        'PAYMENT_AMOUNT_MISMATCH',
        'The amount due is not the amount shown.',
        HttpStatus.CONFLICT,
        [
          { field: 'amountMinor', issue: String(due.amountMinor) },
          { field: 'currency', issue: booking.currency },
          { field: 'purpose', issue: due.purpose },
        ],
      );
    }
    return due;
  }

  private openPayment(
    db: Pick<Prisma.TransactionClient, 'payment'>,
    bookingId: string,
    due: { purpose: PaymentRow['purpose']; amountMinor: bigint },
  ): Promise<PaymentRow | null> {
    return db.payment.findFirst({
      where: {
        bookingId,
        status: { in: OPEN },
        purpose: due.purpose,
        amountMinor: due.amountMinor,
        provider: providerOf(this.gateway),
        providerOrderId: { not: null },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: PAYMENT_FIELDS,
    });
  }

  private toResponse(
    payment: PaymentRow,
    bookingReference: string,
  ): PaymentResponseDto {
    return {
      reference: payment.reference,
      bookingReference,
      status: payment.status,
      purpose: payment.purpose,
      price: {
        priceType: PriceType.CONFIRMED,
        amountMinor: minorToNumber(payment.amountMinor),
        currency: payment.currency,
      },
      checkout: {
        provider: this.gateway.name,
        keyId: this.gateway.checkoutKeyId,
        orderId: payment.providerOrderId ?? '',
      },
      paidAt: payment.paidAt?.toISOString() ?? null,
      createdAt: payment.createdAt.toISOString(),
    };
  }
}

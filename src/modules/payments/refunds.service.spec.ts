import { describe, expect, it, vi } from 'vitest';
import type { IdempotencyClaim } from '../../common/idempotency/idempotency.store.js';
import type {
  GatewayRefund,
  PaymentGatewayProvider,
} from '../../integrations/payment/payment-gateway.provider.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import type { BookingsService } from '../bookings/bookings.service.js';
import type { NotificationEventsService } from '../notifications/events/notification-events.service.js';
import { RefundsService } from './refunds.service.js';

/**
 * A captured payment of 10,000 paise (gateway payment `pay_1`) on a paid
 * booking, refunded in full; the gateway answers the refund with `answer`.
 * One in-memory store stands for the database and its transactions.
 */
async function refundWith(answer: Partial<GatewayRefund>) {
  const refunds: Record<string, unknown>[] = [];
  const payment = {
    id: 'p-1',
    reference: 'FLY-PY-AAAAAA',
    bookingId: 'b-1',
    provider: 'MOCK',
    status: 'SUCCEEDED',
    providerPaymentId: 'pay_1',
    amountMinor: 10_000n,
    currency: 'INR',
    purpose: 'FULL',
    reviewReason: null,
    refunds,
  };
  const booking = {
    id: 'b-1',
    reference: 'FLY-AAAAAA',
    status: 'CONFIRMED',
    paymentStatus: 'PAID',
    totalMinor: 10_000n,
  };
  const db = {
    $transaction: vi.fn((work: (tx: unknown) => unknown) => work(db)),
    idempotencyKey: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    payment: {
      findUnique: vi.fn().mockResolvedValue({ id: 'p-1', bookingId: 'b-1' }),
      findUniqueOrThrow: vi.fn(() => Promise.resolve(payment)),
      findMany: vi.fn(() => Promise.resolve([payment])),
      update: vi.fn(({ data }: { data: object }) =>
        Promise.resolve(Object.assign(payment, data)),
      ),
    },
    booking: {
      findUniqueOrThrow: vi.fn(() =>
        Promise.resolve({
          status: booking.status,
          paymentStatus: booking.paymentStatus,
        }),
      ),
    },
    refund: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: 'r-1',
          providerRefundId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        refunds.push(row);
        return Promise.resolve(row);
      }),
      findUniqueOrThrow: vi.fn(() =>
        Promise.resolve({
          ...refunds[0],
          payment: { ...payment, booking: { reference: booking.reference } },
        }),
      ),
      update: vi.fn(({ data }: { data: object }) =>
        Promise.resolve(Object.assign(refunds[0], data)),
      ),
    },
  };
  const audit = { record: vi.fn() };
  const bookings = {
    forPayment: vi.fn().mockResolvedValue(booking),
    recordPaymentStatus: vi.fn(
      (_tx: unknown, _row: unknown, to: string) => (booking.paymentStatus = to),
    ),
  };
  const gateway = {
    name: 'mock',
    createRefund: vi.fn().mockResolvedValue({
      providerRefundId: 'rfnd_1',
      providerPaymentId: 'pay_1',
      amountMinor: 10_000,
      currency: 'INR',
      status: 'processed',
      ...answer,
    }),
  };
  const events = { notifyBooking: vi.fn() };
  const service = new RefundsService(
    db as unknown as PrismaService,
    audit as unknown as AuditService,
    bookings as unknown as BookingsService,
    gateway as unknown as PaymentGatewayProvider,
    events as unknown as NotificationEventsService,
  );
  const response = await service.start(
    { id: 'u-1' } as AuthUser,
    payment.reference,
    { amountMinor: 10_000, currency: 'INR', reason: 'Goodwill' },
    {} as IdempotencyClaim,
    'key-1',
  );
  const flags = audit.record.mock.calls
    .map(([entry]) => entry as { action: string; after: object })
    .filter((entry) => entry.action === 'refund.flag');
  const notified = events.notifyBooking.mock.calls.map(
    ([, key, bookingId, variables]) => ({ key, bookingId, variables }),
  );
  return { response, payment, flags, notified };
}

describe('RefundsService.start with an answer settled at once', () => {
  it('completes a refund the gateway processed for this payment and amount', async () => {
    const { response, payment, flags, notified } = await refundWith({});
    expect(response).toMatchObject({
      status: 'COMPLETED',
      providerRefundId: 'rfnd_1',
    });
    expect(payment.status).toBe('REFUNDED');
    expect(flags).toEqual([]);
    // Told once it is recorded, and once the money is back.
    expect(notified).toEqual([
      {
        key: 'refund.initiated',
        bookingId: 'b-1',
        variables: { refundReference: response.reference },
      },
      {
        key: 'refund.completed',
        bookingId: 'b-1',
        variables: { refundReference: response.reference },
      },
    ]);
  });

  it('tells operations, not the customer, of a refund the gateway answered as failed', async () => {
    const { response, notified } = await refundWith({ status: 'failed' });
    expect(response.status).toBe('FAILED');
    expect(notified.map((n) => n.key)).toEqual([
      'refund.initiated',
      'refund.failed',
    ]);
  });

  it('leaves a refund answered for another amount or currency REQUESTED, audited for finance', async () => {
    for (const answer of [{ amountMinor: 9_000 }, { currency: 'USD' }]) {
      const { response, payment, flags } = await refundWith(answer);
      expect(response).toMatchObject({
        status: 'REQUESTED',
        providerRefundId: null,
      });
      expect(payment.status).toBe('REFUND_PENDING');
      expect(flags).toHaveLength(1);
      expect(flags[0].after).toMatchObject({
        flagged: 'AMOUNT_MISMATCH',
        amountMinor: 10_000,
        reportedProviderRefundId: 'rfnd_1',
        source: 'gateway',
      });
    }
  });

  it('leaves a refund answered for another gateway payment REQUESTED, audited for finance', async () => {
    const { response, flags } = await refundWith({
      providerPaymentId: 'pay_other',
    });
    expect(response).toMatchObject({
      status: 'REQUESTED',
      providerRefundId: null,
    });
    expect(flags).toHaveLength(1);
    expect(flags[0].after).toMatchObject({
      flagged: 'PAYMENT_MISMATCH',
      reportedProviderPaymentId: 'pay_other',
    });
  });

  it('still records a pending answer as before', async () => {
    const { response, flags, notified } = await refundWith({
      status: 'pending',
      amountMinor: 9_000,
    });
    expect(response).toMatchObject({
      status: 'PENDING',
      providerRefundId: 'rfnd_1',
    });
    expect(flags).toEqual([]);
    expect(notified.map((n) => n.key)).toEqual(['refund.initiated']);
  });
});

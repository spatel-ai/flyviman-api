import type { NotificationEventsService } from '../notifications/events/notification-events.service.js';
import type { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import {
  PaymentGatewayError,
  type PaymentGatewayProvider,
} from '../../integrations/payment/payment-gateway.provider.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { AuditService } from '../audit/audit.service.js';
import type { BookingsService } from '../bookings/bookings.service.js';
import type { RefundsService } from './refunds.service.js';
import {
  PaymentWebhooksService,
  REFUSAL_LOG_WINDOW_MS,
} from './payment-webhooks.service.js';

function setup() {
  const gateway = {
    name: 'mock',
    parseWebhook: vi.fn().mockReturnValue({ ok: false, reason: 'signature' }),
  };
  const transaction = vi.fn();
  const service = new PaymentWebhooksService(
    gateway as unknown as PaymentGatewayProvider,
    { $transaction: transaction } as unknown as PrismaService,
    {} as AuditService,
    {} as BookingsService,
    {} as RefundsService,
    {} as Redis,
    {} as NotificationEventsService,
  );
  const warn = vi.fn();
  (service as unknown as { logger: Pick<Logger, 'warn'> }).logger = { warn };
  const refuse = () =>
    expect(
      service.receive('mock', Buffer.from('{}'), {}),
    ).rejects.toMatchObject({ code: 'WEBHOOK_SIGNATURE_INVALID' });
  return { refuse, warn, transaction };
}

describe('PaymentWebhooksService refusal logging', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-19T10:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('warns once a minute, with the count of refusals since the last warning', async () => {
    const { refuse, warn } = setup();
    for (let n = 0; n < 50; n += 1) await refuse();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('refusals=1');

    vi.setSystemTime(Date.now() + REFUSAL_LOG_WINDOW_MS);
    await refuse();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1][0]).toContain('refusals=50');
    expect(warn.mock.calls[1][0]).not.toMatch(/\{\}/);
  });
});

describe('PaymentWebhooksService refusals', () => {
  it('stores and applies nothing for a bad signature, a malformed event or a body that is not raw', async () => {
    const { refuse, transaction } = setup();
    await refuse();
    const gateway = {
      name: 'mock',
      parseWebhook: vi.fn().mockReturnValue({ ok: false, reason: 'payload' }),
    };
    const service = new PaymentWebhooksService(
      gateway as unknown as PaymentGatewayProvider,
      { $transaction: transaction } as unknown as PrismaService,
      {} as AuditService,
      {} as BookingsService,
      {} as RefundsService,
      {} as Redis,
      {} as NotificationEventsService,
    );
    await expect(
      service.receive('mock', Buffer.from('{}'), {}),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    // A parsed (not raw) body is never verified.
    await expect(
      service.receive('mock', { event: 'payment.captured' }, {}),
    ).rejects.toMatchObject({ code: 'WEBHOOK_SIGNATURE_INVALID' });
    expect(gateway.parseWebhook).toHaveBeenCalledTimes(1);
    await expect(
      service.receive('razorpay', Buffer.from('{}'), {}),
    ).rejects.toThrow();
    expect(transaction).not.toHaveBeenCalled();
  });
});

/** A payment open for 10,000 paise on a booking awaiting payment. */
function paymentWorld(overrides: Record<string, unknown> = {}) {
  const payment = {
    id: 'p-1',
    reference: 'FLY-PY-AAAAAA',
    bookingId: 'b-1',
    status: 'INITIATED',
    providerOrderId: 'order_1',
    providerPaymentId: null as string | null,
    amountMinor: 10_000n,
    currency: 'INR',
    purpose: 'FULL',
    reviewReason: null as string | null,
    reviewResolvedAt: null as Date | null,
    ...overrides,
  };
  const booking = {
    id: 'b-1',
    reference: 'FLY-AAAAAA',
    status: 'AWAITING_PAYMENT',
    paymentStatus: 'UNPAID',
  };
  const tx = {
    payment: {
      findUnique: vi.fn().mockResolvedValue({ id: 'p-1', bookingId: 'b-1' }),
      findUniqueOrThrow: vi.fn(() => Promise.resolve({ ...payment })),
      update: vi.fn(({ data }: { data: Record<string, unknown> }) => {
        Object.assign(payment, data);
        return Promise.resolve(payment);
      }),
    },
    paymentEvent: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn(),
    },
  };
  const audit = {
    record: vi.fn(),
    exists: vi.fn().mockResolvedValue(false),
  };
  const bookings = {
    forPayment: vi.fn().mockResolvedValue(booking),
    recordPaymentStatus: vi.fn().mockResolvedValue({ confirmed: true }),
  };
  const gateway = {
    name: 'mock',
    parseWebhook: vi.fn(),
    fetchPayment: vi.fn(),
    fetchOrderPayments: vi.fn().mockResolvedValue([]),
  };
  const redis = { set: vi.fn().mockResolvedValue('OK'), eval: vi.fn() };
  const prisma = {
    $transaction: vi.fn((work: (t: typeof tx) => unknown) => work(tx)),
    payment: { findMany: vi.fn().mockResolvedValue([]) },
    paymentEvent: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const service = new PaymentWebhooksService(
    gateway as unknown as PaymentGatewayProvider,
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
    bookings as unknown as BookingsService,
    {} as RefundsService,
    redis as unknown as Redis,
    { notifyBooking: vi.fn() } as unknown as NotificationEventsService,
  );
  const deliver = (event: Record<string, unknown>) => {
    gateway.parseWebhook.mockReturnValue({
      ok: true,
      event: {
        providerEventId: 'evt_1',
        type: 'payment.captured',
        providerOrderId: 'order_1',
        providerPaymentId: 'pay_1',
        amountMinor: 10_000,
        currency: 'INR',
        ...event,
      },
    });
    return service.receive('mock', Buffer.from('{}'), {});
  };
  return {
    payment,
    tx,
    audit,
    bookings,
    gateway,
    prisma,
    redis,
    service,
    deliver,
  };
}

describe('PaymentWebhooksService applying notices', () => {
  it('applies a capture on its first delivery', async () => {
    const world = paymentWorld();
    await world.deliver({});
    expect(world.payment).toMatchObject({
      status: 'SUCCEEDED',
      providerPaymentId: 'pay_1',
    });
    expect(world.bookings.recordPaymentStatus).toHaveBeenCalledTimes(1);
    expect(world.audit.record.mock.calls[0][0].after).toMatchObject({
      source: 'webhook',
      providerEventId: 'evt_1',
    });
  });

  it('applies an early notice when it is delivered again and its order is known now', async () => {
    const world = paymentWorld();
    world.tx.paymentEvent.createMany.mockResolvedValue({ count: 0 });
    world.tx.paymentEvent.findUnique.mockResolvedValue({
      paymentId: null,
      type: 'payment.captured',
    });
    await world.deliver({});
    expect(world.payment.status).toBe('SUCCEEDED');
    expect(world.audit.record.mock.calls[0][0].after).toMatchObject({
      source: 'webhook-redelivery',
      providerEventId: 'evt_1',
    });

    // A third delivery changes nothing: the payment is already paid by it.
    world.audit.record.mockClear();
    world.tx.payment.update.mockClear();
    await world.deliver({});
    expect(world.tx.payment.update).not.toHaveBeenCalled();
    expect(world.audit.record).not.toHaveBeenCalled();
  });

  it('never applies again a notice that was applied when it was stored', async () => {
    const world = paymentWorld();
    world.tx.paymentEvent.createMany.mockResolvedValue({ count: 0 });
    world.tx.paymentEvent.findUnique.mockResolvedValue({
      paymentId: 'p-1',
      type: 'payment.captured',
    });
    await world.deliver({});
    expect(world.tx.payment.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(world.payment.status).toBe('INITIATED');
  });

  it('stores a notice for an unknown order and applies nothing', async () => {
    const world = paymentWorld();
    world.tx.payment.findUnique.mockResolvedValue(null);
    await world.deliver({});
    expect(
      world.tx.paymentEvent.createMany.mock.calls[0][0].data,
    ).toMatchObject({ paymentId: null, processedAt: null });
    expect(world.payment.status).toBe('INITIATED');
  });

  it('flags a second capture with another gateway payment id and keeps the first', async () => {
    const world = paymentWorld({
      status: 'SUCCEEDED',
      providerPaymentId: 'pay_1',
    });
    await world.deliver({
      providerEventId: 'evt_2',
      providerPaymentId: 'pay_2',
    });
    expect(world.payment).toMatchObject({
      status: 'SUCCEEDED',
      providerPaymentId: 'pay_1',
      reviewReason: 'DUPLICATE_CAPTURE',
    });
    expect(world.audit.record.mock.calls[0][0]).toMatchObject({
      action: 'payment.flag',
      after: {
        flagged: 'DUPLICATE_CAPTURE',
        reportedProviderPaymentId: 'pay_2',
      },
    });
    expect(world.bookings.recordPaymentStatus).not.toHaveBeenCalled();
  });

  it('still audits a duplicate capture when another reason is already set', async () => {
    const world = paymentWorld({
      status: 'SUCCEEDED',
      providerPaymentId: 'pay_1',
      reviewReason: 'ALREADY_PAID',
    });
    await world.deliver({
      providerEventId: 'evt_2',
      providerPaymentId: 'pay_2',
    });
    // The first reason stays; the only write reopens a resolved flag.
    expect(world.tx.payment.update).toHaveBeenCalledTimes(1);
    expect(world.tx.payment.update.mock.calls[0][0].data).toEqual({
      reviewResolvedAt: null,
    });
    expect(world.payment.reviewReason).toBe('ALREADY_PAID');
    expect(world.audit.record.mock.calls[0][0].after).toMatchObject({
      reviewReason: 'ALREADY_PAID',
      flagged: 'DUPLICATE_CAPTURE',
    });
  });

  it('still audits a refused amount mismatch when another reason is already set', async () => {
    const world = paymentWorld({ reviewReason: 'ALREADY_PAID' });
    await world.deliver({ amountMinor: 9_000 });
    expect(world.tx.payment.update).toHaveBeenCalledTimes(1);
    expect(world.tx.payment.update.mock.calls[0][0].data).toEqual({
      reviewResolvedAt: null,
    });
    expect(world.payment.reviewReason).toBe('ALREADY_PAID');
    expect(world.payment.status).toBe('INITIATED');
    expect(world.audit.record).toHaveBeenCalledTimes(1);
    expect(world.audit.record.mock.calls[0][0]).toMatchObject({
      action: 'payment.flag',
      actor: null,
      before: { status: 'INITIATED', reviewReason: 'ALREADY_PAID' },
      after: {
        status: 'INITIATED',
        reviewReason: 'ALREADY_PAID',
        flagged: 'AMOUNT_MISMATCH',
        reportedAmountMinor: 9_000,
        source: 'webhook',
        providerEventId: 'evt_1',
      },
    });
  });
});

describe('PaymentWebhooksService when the confirmation is blocked', () => {
  it('flags a success for a trip that can no longer be flown as booked, so it is listed for refund', async () => {
    const world = paymentWorld();
    world.bookings.recordPaymentStatus.mockResolvedValue({
      confirmed: false,
      reason: 'the aircraft time is no longer free',
      unbookable: true,
    });
    await world.deliver({});
    // The success and the booking's summary are recorded all the same.
    expect(world.payment).toMatchObject({
      status: 'SUCCEEDED',
      reviewReason: 'BOOKING_CLOSED',
    });
    expect(world.bookings.recordPaymentStatus.mock.calls[0][2]).toBe('PAID');
    const flags = world.audit.record.mock.calls
      .map((call) => call[0])
      .filter((entry) => entry.action === 'payment.flag');
    expect(flags).toEqual([
      expect.objectContaining({
        actor: null,
        before: expect.objectContaining({
          status: 'SUCCEEDED',
          reviewReason: null,
        }),
        after: expect.objectContaining({
          status: 'SUCCEEDED',
          reviewReason: 'BOOKING_CLOSED',
          flagged: 'BOOKING_CLOSED',
          confirmationBlocked: 'the aircraft time is no longer free',
          source: 'webhook',
        }),
      }),
    ]);
  });

  it('never flags a success the confirmation rule is only waiting on (rule 2)', async () => {
    const world = paymentWorld();
    world.bookings.recordPaymentStatus.mockResolvedValue({
      confirmed: false,
      reason: 'the operator has not accepted',
      unbookable: false,
    });
    await world.deliver({});
    expect(world.payment).toMatchObject({
      status: 'SUCCEEDED',
      reviewReason: null,
    });
    expect(
      world.audit.record.mock.calls.map((call) => call[0].action),
    ).not.toContain('payment.flag');
  });
});

describe('PaymentWebhooksService flag records', () => {
  it('records a refused amount mismatch once per payment, however often its notice comes again', async () => {
    const world = paymentWorld({ reviewReason: 'ALREADY_PAID' });
    world.audit.exists.mockResolvedValue(true);
    world.tx.paymentEvent.createMany.mockResolvedValue({ count: 0 });
    world.tx.paymentEvent.findUnique.mockResolvedValue({
      paymentId: null,
      type: 'payment.captured',
    });
    await world.deliver({ amountMinor: 9_000 });
    expect(world.audit.exists).toHaveBeenCalledWith(
      {
        action: 'payment.flag',
        entityType: 'Payment',
        entityId: 'p-1',
        after: { flagged: 'AMOUNT_MISMATCH' },
      },
      world.tx,
    );
    expect(world.audit.record).not.toHaveBeenCalled();
    expect(world.tx.payment.update).not.toHaveBeenCalled();
    expect(world.payment.status).toBe('INITIATED');
  });

  it('records each duplicate capture once per gateway payment: a new one is still recorded', async () => {
    const world = paymentWorld({
      status: 'SUCCEEDED',
      providerPaymentId: 'pay_1',
      reviewReason: 'DUPLICATE_CAPTURE',
    });
    world.audit.exists.mockImplementation(
      (where: { after: { reportedProviderPaymentId?: string } }) =>
        Promise.resolve(where.after.reportedProviderPaymentId === 'pay_2'),
    );
    await world.deliver({
      providerEventId: 'evt_2',
      providerPaymentId: 'pay_2',
    });
    expect(world.audit.record).not.toHaveBeenCalled();
    await world.deliver({
      providerEventId: 'evt_3',
      providerPaymentId: 'pay_3',
    });
    expect(world.audit.record).toHaveBeenCalledTimes(1);
    expect(world.audit.record.mock.calls[0][0].after).toMatchObject({
      flagged: 'DUPLICATE_CAPTURE',
      reportedProviderPaymentId: 'pay_3',
    });
  });

  it('reopens a resolved flag when a new flag is recorded, never on a redelivery', async () => {
    const resolvedAt = new Date('2026-11-20T10:00:00.000Z');
    const world = paymentWorld({
      status: 'SUCCEEDED',
      providerPaymentId: 'pay_1',
      reviewReason: 'DUPLICATE_CAPTURE',
      reviewResolvedAt: resolvedAt,
    });
    world.audit.exists.mockImplementation(
      (where: { after: { reportedProviderPaymentId?: string } }) =>
        Promise.resolve(where.after.reportedProviderPaymentId === 'pay_2'),
    );
    // The capture already recorded, delivered again: stays resolved.
    await world.deliver({
      providerEventId: 'evt_2',
      providerPaymentId: 'pay_2',
    });
    expect(world.payment.reviewResolvedAt).toBe(resolvedAt);
    // A new capture: open again, listed and blocking erasure.
    await world.deliver({
      providerEventId: 'evt_3',
      providerPaymentId: 'pay_3',
    });
    expect(world.payment.reviewResolvedAt).toBeNull();
    expect(world.payment.reviewReason).toBe('DUPLICATE_CAPTURE');
  });

  it('always records the flag that sets the reason', async () => {
    const world = paymentWorld();
    world.audit.exists.mockResolvedValue(true);
    await world.deliver({ amountMinor: 9_000 });
    expect(world.payment.reviewReason).toBe('AMOUNT_MISMATCH');
    expect(world.audit.record).toHaveBeenCalledTimes(1);
  });
});

describe('PaymentWebhooksService status sweep', () => {
  const open = {
    id: 'p-1',
    bookingId: 'b-1',
    providerOrderId: 'order_1',
    providerPaymentId: null,
  };

  it('settles an open payment from the gateway, using the payment id of an early notice', async () => {
    const world = paymentWorld();
    world.prisma.payment.findMany.mockResolvedValue([open]);
    world.prisma.paymentEvent.findMany.mockResolvedValue([
      { payload: { providerOrderId: 'order_1', providerPaymentId: 'pay_9' } },
    ]);
    world.gateway.fetchPayment.mockResolvedValue({
      providerPaymentId: 'pay_9',
      providerOrderId: 'order_1',
      amountMinor: 10_000,
      currency: 'INR',
      status: 'captured',
      amountRefundedMinor: 0,
    });

    expect(await world.service.runSweep()).toEqual({
      checked: 1,
      applied: 1,
      skipped: false,
    });
    expect(world.gateway.fetchPayment).toHaveBeenCalledWith('pay_9');
    expect(world.payment).toMatchObject({
      status: 'SUCCEEDED',
      providerPaymentId: 'pay_9',
    });
    expect(world.audit.record.mock.calls[0][0].after).toMatchObject({
      source: 'sweep',
    });
    expect(world.redis.eval).toHaveBeenCalledTimes(1);
  });

  it('leaves a payment the gateway does not settle, or reports for another order', async () => {
    const world = paymentWorld();
    world.prisma.payment.findMany.mockResolvedValue([
      { ...open, providerPaymentId: 'pay_1', status: 'PENDING' },
    ]);
    for (const answer of [
      Promise.reject(new PaymentGatewayError('NOT_FOUND', 'No such payment.')),
      Promise.resolve({
        providerPaymentId: 'pay_1',
        providerOrderId: 'order_1',
        amountMinor: 10_000,
        currency: 'INR',
        status: 'authorized',
        amountRefundedMinor: 0,
      }),
      Promise.resolve({
        providerPaymentId: 'pay_1',
        providerOrderId: 'order_other',
        amountMinor: 10_000,
        currency: 'INR',
        status: 'captured',
        amountRefundedMinor: 0,
      }),
    ]) {
      answer.catch(() => undefined);
      world.gateway.fetchPayment.mockReturnValueOnce(answer);
      expect((await world.service.runSweep()).applied).toBe(0);
    }
    expect(world.prisma.$transaction).not.toHaveBeenCalled();
    expect(world.payment.status).toBe('INITIATED');
  });

  it('asks the gateway by order for a payment with no gateway payment id (W4-1)', async () => {
    const world = paymentWorld();
    world.prisma.payment.findMany.mockResolvedValue([open]);
    const captured = {
      providerPaymentId: 'pay_7',
      providerOrderId: 'order_1',
      amountMinor: 10_000,
      currency: 'INR',
      status: 'captured',
      amountRefundedMinor: 0,
      method: 'upi',
    };
    world.gateway.fetchOrderPayments.mockResolvedValue([captured]);
    world.gateway.fetchPayment.mockResolvedValue(captured);

    expect((await world.service.runSweep()).applied).toBe(1);
    expect(world.gateway.fetchOrderPayments).toHaveBeenCalledWith('order_1');
    expect(world.payment).toMatchObject({
      status: 'SUCCEEDED',
      providerPaymentId: 'pay_7',
      method: 'upi',
    });
  });

  it('leaves a payment whose order has no payments, and skips while another instance runs', async () => {
    const world = paymentWorld();
    world.prisma.payment.findMany.mockResolvedValue([open]);
    expect((await world.service.runSweep()).checked).toBe(1);
    expect(world.gateway.fetchOrderPayments).toHaveBeenCalledWith('order_1');
    expect(world.gateway.fetchPayment).not.toHaveBeenCalled();

    world.redis.set.mockResolvedValue(null);
    expect(await world.service.runSweep()).toEqual({
      checked: 0,
      applied: 0,
      skipped: true,
    });
  });
});

describe('PaymentWebhooksService status sweep of failed payments', () => {
  const NOW = new Date('2026-11-21T12:00:00.000Z');
  const failed = {
    id: 'p-1',
    bookingId: 'b-1',
    status: 'FAILED',
    providerOrderId: 'order_1',
    providerPaymentId: 'pay_failed',
  };
  const attempt = (overrides: Record<string, unknown>) => ({
    providerPaymentId: 'pay_failed',
    providerOrderId: 'order_1',
    amountMinor: 10_000,
    currency: 'INR',
    status: 'failed',
    amountRefundedMinor: 0,
    ...overrides,
  });
  function failedWorld() {
    const world = paymentWorld({
      status: 'FAILED',
      providerPaymentId: 'pay_failed',
    });
    world.prisma.payment.findMany.mockResolvedValue([failed]);
    return world;
  }

  it('asks only for failed payments whose booking awaits payment or whose order is recent', async () => {
    const world = paymentWorld();
    await world.service.runSweep(NOW);
    const { where } = world.prisma.payment.findMany.mock.calls[0][0];
    expect(where.OR).toEqual([
      { status: { in: ['INITIATED', 'PENDING'] } },
      {
        status: 'FAILED',
        OR: [
          { booking: { status: 'AWAITING_PAYMENT' } },
          { createdAt: { gte: new Date('2026-11-21T10:00:00.000Z') } },
        ],
      },
    ]);
    // The same age window as an open payment.
    expect(where.createdAt).toEqual({
      gte: new Date('2026-11-19T12:00:00.000Z'),
    });
  });

  it('applies a retry captured in the same order whose notice was lost', async () => {
    const world = failedWorld();
    world.gateway.fetchOrderPayments.mockResolvedValue([
      attempt({}),
      attempt({ providerPaymentId: 'pay_ok', status: 'captured' }),
    ]);

    expect((await world.service.runSweep(NOW)).applied).toBe(1);
    expect(world.gateway.fetchOrderPayments).toHaveBeenCalledWith('order_1');
    // The listed answers are used as they are; the failed attempt opens no
    // transaction.
    expect(world.gateway.fetchPayment).not.toHaveBeenCalled();
    expect(world.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(world.payment).toMatchObject({
      status: 'SUCCEEDED',
      providerPaymentId: 'pay_ok',
    });
    expect(world.bookings.recordPaymentStatus).toHaveBeenCalledTimes(1);
    expect(world.audit.record.mock.calls[0][0]).toMatchObject({
      action: 'payment.status',
      before: { status: 'FAILED' },
      after: { status: 'SUCCEEDED', source: 'sweep' },
    });
  });

  it('flags a second capture in the order, never applied twice (rule 5)', async () => {
    const world = failedWorld();
    world.gateway.fetchOrderPayments.mockResolvedValue([
      attempt({}),
      attempt({ providerPaymentId: 'pay_ok', status: 'captured' }),
      attempt({ providerPaymentId: 'pay_twice', status: 'captured' }),
    ]);

    await world.service.runSweep(NOW);
    expect(world.payment).toMatchObject({
      status: 'SUCCEEDED',
      providerPaymentId: 'pay_ok',
      reviewReason: 'DUPLICATE_CAPTURE',
    });
    expect(world.bookings.recordPaymentStatus).toHaveBeenCalledTimes(1);
  });

  it('leaves a payment whose order has only failed attempts, or that the gateway cannot list', async () => {
    const world = failedWorld();
    world.gateway.fetchOrderPayments.mockResolvedValue([attempt({})]);
    expect((await world.service.runSweep(NOW)).applied).toBe(0);
    world.gateway.fetchOrderPayments.mockRejectedValue(
      new PaymentGatewayError('UNAVAILABLE', 'The gateway is down.'),
    );
    expect((await world.service.runSweep(NOW)).applied).toBe(0);
    expect(world.prisma.$transaction).not.toHaveBeenCalled();
    expect(world.payment.status).toBe('FAILED');
  });
});

describe('PaymentWebhooksService a payment refunded at the gateway before it was settled', () => {
  const refunded = {
    providerPaymentId: 'pay_1',
    providerOrderId: 'order_1',
    amountMinor: 10_000,
    currency: 'INR',
    status: 'refunded',
    amountRefundedMinor: 10_000,
  };

  it('is flagged for finance, never counted as paid, and recorded once', async () => {
    const world = paymentWorld({
      status: 'PENDING',
      providerPaymentId: 'pay_1',
    });
    world.prisma.payment.findMany.mockResolvedValue([
      {
        id: 'p-1',
        bookingId: 'b-1',
        status: 'PENDING',
        providerOrderId: 'order_1',
        providerPaymentId: 'pay_1',
      },
    ]);
    world.gateway.fetchPayment.mockResolvedValue(refunded);

    expect((await world.service.runSweep()).applied).toBe(1);
    expect(world.payment).toMatchObject({
      status: 'PENDING',
      reviewReason: 'AMOUNT_MISMATCH',
    });
    expect(world.bookings.recordPaymentStatus).not.toHaveBeenCalled();
    expect(world.audit.record).toHaveBeenCalledTimes(1);
    expect(world.audit.record.mock.calls[0][0]).toMatchObject({
      action: 'payment.flag',
      after: {
        flagged: 'AMOUNT_MISMATCH',
        gatewayStatus: 'refunded',
        amountRefundedMinor: 10_000,
        source: 'sweep',
      },
    });

    // The next run asks again and records nothing more.
    expect((await world.service.runSweep()).applied).toBe(0);
    expect(world.audit.record).toHaveBeenCalledTimes(1);
  });
});

describe('PaymentWebhooksService settling right after a checkout result', () => {
  const pending = {
    id: 'p-1',
    bookingId: 'b-1',
    providerOrderId: 'order_1',
    providerPaymentId: 'pay_1',
  };
  const reported = (overrides: Record<string, unknown> = {}) => ({
    providerPaymentId: 'pay_1',
    providerOrderId: 'order_1',
    amountMinor: 10_000,
    currency: 'INR',
    status: 'captured',
    amountRefundedMinor: 0,
    method: 'upi',
    ...overrides,
  });
  function world(row: Record<string, unknown> | null = pending) {
    const built = paymentWorld({
      status: 'PENDING',
      providerPaymentId: 'pay_1',
    });
    const findUnique = vi.fn().mockResolvedValue(row);
    Object.assign(built.prisma.payment, { findUnique });
    return { ...built, findUnique };
  }

  it("applies the gateway's own capture at once, through the sweep's path", async () => {
    const settle = world();
    settle.gateway.fetchPayment.mockResolvedValue(reported());

    expect(await settle.service.settleFromGateway('p-1', 'pay_1')).toBe(true);
    expect(settle.gateway.fetchPayment).toHaveBeenCalledWith('pay_1');
    expect(settle.payment).toMatchObject({
      status: 'SUCCEEDED',
      providerPaymentId: 'pay_1',
      method: 'upi',
    });
    expect(settle.audit.record.mock.calls[0][0].after).toMatchObject({
      status: 'SUCCEEDED',
      source: 'checkout-fetch',
    });
    // The booking moves only through the confirmation rule (rule 2).
    expect(settle.bookings.recordPaymentStatus).toHaveBeenCalledTimes(1);

    // The same capture again (a repeated checkout result, then its notice)
    // changes nothing more (rule 5).
    settle.audit.record.mockClear();
    expect(await settle.service.settleFromGateway('p-1', 'pay_1')).toBe(false);
    expect(settle.audit.record).not.toHaveBeenCalled();
  });

  it('applies a failure the gateway reports', async () => {
    const settle = world();
    settle.gateway.fetchPayment.mockResolvedValue(
      reported({ status: 'failed' }),
    );
    expect(await settle.service.settleFromGateway('p-1', 'pay_1')).toBe(true);
    expect(settle.payment.status).toBe('FAILED');
  });

  it('leaves the payment PENDING when the capture is still to come, the gateway is down, or it reports another order', async () => {
    for (const answer of [
      () => Promise.resolve(reported({ status: 'authorized' })),
      () => Promise.resolve(reported({ status: 'created' })),
      () =>
        Promise.reject(
          new PaymentGatewayError('UNAVAILABLE', 'The gateway is down.'),
        ),
      () => Promise.resolve(reported({ providerOrderId: 'order_other' })),
    ]) {
      const settle = world();
      settle.gateway.fetchPayment.mockImplementation(answer);
      expect(await settle.service.settleFromGateway('p-1', 'pay_1')).toBe(
        false,
      );
      expect(settle.payment.status).toBe('PENDING');
      expect(settle.prisma.$transaction).not.toHaveBeenCalled();
    }
  });

  it('asks about the checkout payment after a failed attempt in the same order', async () => {
    const settle = world({ ...pending, providerPaymentId: 'pay_failed' });
    Object.assign(settle.payment, {
      status: 'FAILED',
      providerPaymentId: 'pay_failed',
    });
    settle.gateway.fetchPayment.mockImplementation((id: string) =>
      Promise.resolve(
        id === 'pay_ok'
          ? reported({ providerPaymentId: 'pay_ok' })
          : reported({ providerPaymentId: 'pay_failed', status: 'failed' }),
      ),
    );

    expect(await settle.service.settleFromGateway('p-1', 'pay_ok')).toBe(true);
    expect(settle.gateway.fetchPayment).toHaveBeenCalledWith('pay_ok');
    expect(settle.payment).toMatchObject({
      status: 'SUCCEEDED',
      providerPaymentId: 'pay_ok',
    });
  });

  it('never throws: an unknown payment or a failing database settles nothing', async () => {
    expect(await world(null).service.settleFromGateway('p-x', 'pay_1')).toBe(
      false,
    );
    const broken = world();
    broken.findUnique.mockRejectedValue(
      new Error('connection reset for pay_1'),
    );
    const error = vi.fn();
    (broken.service as unknown as { logger: Pick<Logger, 'error'> }).logger = {
      error,
    };
    expect(await broken.service.settleFromGateway('p-1', 'pay_1')).toBe(false);
    expect(error).toHaveBeenCalledWith(
      'Payment check after checkout failed: Error',
    );
  });
});

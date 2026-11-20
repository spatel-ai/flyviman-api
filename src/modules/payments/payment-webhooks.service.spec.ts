import type { NotificationEventsService } from '../notifications/events/notification-events.service.js';
import type { Logger } from '@nestjs/common';
import type { PaymentGatewayProvider } from '../../integrations/payment/payment-gateway.provider.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { AuditService } from '../audit/audit.service.js';
import type { BookingsService } from '../bookings/bookings.service.js';
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

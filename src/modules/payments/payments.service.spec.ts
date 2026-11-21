import { describe, expect, it, vi } from 'vitest';
import type { PaymentGatewayProvider } from '../../integrations/payment/payment-gateway.provider.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import type { BookingsService } from '../bookings/bookings.service.js';
import type { CategoryConfigService } from '../configuration/category-config.service.js';
import type { PaymentWebhooksService } from './payment-webhooks.service.js';
import { PaymentsService } from './payments.service.js';

const customer = {
  id: 'u-1',
  role: 'CUSTOMER',
  sessionFamilyId: 's-1',
} as unknown as AuthUser;

const result = {
  providerOrderId: 'order_1',
  providerPaymentId: 'pay_1',
  signature: 'a'.repeat(64),
};

/** One payment on a booking, as `verify` reads and writes it. */
function world(status: string, settles = false) {
  const row = {
    id: 'p-1',
    reference: 'FLY-PY-AAAAAA',
    bookingId: 'b-1',
    providerOrderId: 'order_1',
    providerPaymentId: null as string | null,
    purpose: 'FULL',
    amountMinor: 10_000n,
    currency: 'INR',
    status,
    paidAt: null as Date | null,
    createdAt: new Date('2026-11-21T10:00:00.000Z'),
  };
  const tx = {
    payment: {
      findUniqueOrThrow: vi.fn(() => Promise.resolve({ ...row })),
      update: vi.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve(Object.assign(row, data)),
      ),
    },
  };
  const prisma = {
    payment: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'p-1',
        bookingId: 'b-1',
        providerOrderId: 'order_1',
      }),
      // The row as the settlement left it.
      findUniqueOrThrow: vi.fn(() =>
        Promise.resolve({
          ...row,
          status: 'SUCCEEDED',
          paidAt: new Date('2026-11-21T10:01:00.000Z'),
        }),
      ),
    },
    $transaction: vi.fn((work: (t: typeof tx) => unknown) => work(tx)),
  };
  const gateway = {
    name: 'razorpay',
    checkoutKeyId: 'rzp_test_key',
    verifyCheckoutSignature: vi.fn().mockReturnValue(true),
  };
  const webhooks = { settleFromGateway: vi.fn().mockResolvedValue(settles) };
  const service = new PaymentsService(
    prisma as unknown as PrismaService,
    { record: vi.fn() } as unknown as AuditService,
    {
      forPayment: vi
        .fn()
        .mockResolvedValue({ id: 'b-1', reference: 'FLY-BK-AAAAAA' }),
      keepHoldForPayment: vi.fn(),
    } as unknown as BookingsService,
    {} as CategoryConfigService,
    gateway as unknown as PaymentGatewayProvider,
    webhooks as unknown as PaymentWebhooksService,
  );
  return { service, gateway, webhooks, prisma };
}

describe('PaymentsService.verify', () => {
  it("settles a signed result from the gateway's own status in the same answer", async () => {
    const { service, webhooks } = world('INITIATED', true);

    const answer = await service.verify(customer, 'FLY-PY-AAAAAA', result);

    expect(webhooks.settleFromGateway).toHaveBeenCalledWith('p-1', 'pay_1');
    expect(answer).toMatchObject({
      status: 'SUCCEEDED',
      bookingReference: 'FLY-BK-AAAAAA',
      paidAt: '2026-11-21T10:01:00.000Z',
    });
  });

  it('answers PENDING when the gateway does not settle it (capture to come, gateway down)', async () => {
    const { service, webhooks, prisma } = world('INITIATED', false);

    const answer = await service.verify(customer, 'FLY-PY-AAAAAA', result);

    expect(webhooks.settleFromGateway).toHaveBeenCalledTimes(1);
    expect(answer.status).toBe('PENDING');
    expect(prisma.payment.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('asks again after a failed attempt in the same order, about the checkout payment', async () => {
    const { service, webhooks } = world('FAILED', true);

    expect(
      (await service.verify(customer, 'FLY-PY-AAAAAA', result)).status,
    ).toBe('SUCCEEDED');
    expect(webhooks.settleFromGateway).toHaveBeenCalledWith('p-1', 'pay_1');
  });

  it('never asks about a payment already paid', async () => {
    const { service, webhooks } = world('SUCCEEDED');

    expect(
      (await service.verify(customer, 'FLY-PY-AAAAAA', result)).status,
    ).toBe('SUCCEEDED');
    expect(webhooks.settleFromGateway).not.toHaveBeenCalled();
  });

  it('never asks the gateway for a bad signature or another order’s result', async () => {
    const forged = world('INITIATED', true);
    forged.gateway.verifyCheckoutSignature.mockReturnValue(false);
    await expect(
      forged.service.verify(customer, 'FLY-PY-AAAAAA', result),
    ).rejects.toMatchObject({ code: 'PAYMENT_SIGNATURE_INVALID' });

    const other = world('INITIATED', true);
    await expect(
      other.service.verify(customer, 'FLY-PY-AAAAAA', {
        ...result,
        providerOrderId: 'order_other',
      }),
    ).rejects.toMatchObject({ code: 'PAYMENT_SIGNATURE_INVALID' });

    expect(forged.webhooks.settleFromGateway).not.toHaveBeenCalled();
    expect(other.webhooks.settleFromGateway).not.toHaveBeenCalled();
    expect(forged.prisma.$transaction).not.toHaveBeenCalled();
  });
});

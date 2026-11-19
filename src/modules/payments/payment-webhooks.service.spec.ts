import type { Logger } from '@nestjs/common';
import type { PaymentGatewayProvider } from '../../integrations/payment/payment-gateway.provider.js';
import {
  PaymentWebhooksService,
  REFUSAL_LOG_WINDOW_MS,
} from './payment-webhooks.service.js';

function setup() {
  const gateway = {
    name: 'mock',
    parseWebhook: vi.fn().mockReturnValue({ ok: false, reason: 'signature' }),
  };
  const service = new PaymentWebhooksService(
    gateway as unknown as PaymentGatewayProvider,
  );
  const warn = vi.fn();
  (service as unknown as { logger: Pick<Logger, 'warn'> }).logger = { warn };
  const refuse = () =>
    expect(() => service.receive('mock', Buffer.from('{}'), {})).toThrow();
  return { refuse, warn };
}

describe('PaymentWebhooksService refusal logging', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-19T10:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('warns once a minute, with the count of refusals since the last warning', () => {
    const { refuse, warn } = setup();
    for (let n = 0; n < 50; n += 1) refuse();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('refusals=1');

    vi.setSystemTime(Date.now() + REFUSAL_LOG_WINDOW_MS);
    refuse();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1][0]).toContain('refusals=50');
    expect(warn.mock.calls[1][0]).not.toMatch(/\{\}/);
  });
});

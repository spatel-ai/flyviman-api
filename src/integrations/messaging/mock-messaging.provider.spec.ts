import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  maskRecipient,
  MockMessagingProvider,
} from './mock-messaging.provider.js';

function provider(nodeEnv: string): MockMessagingProvider {
  const config = { get: () => nodeEnv } as unknown as ConfigService;
  return new MockMessagingProvider(config);
}

const message = {
  channel: 'EMAIL' as const,
  to: 'asha@example.com',
  subject: 'Reset your password',
  body: 'Open https://flyviman.test/reset-password?token=secret-token',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MockMessagingProvider', () => {
  it('prints a message to the log in development, with the recipient masked', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    await provider('development').send(message);

    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0][0]);
    expect(line).toContain('a***@example.com');
    expect(line).not.toContain('asha@example.com');
  });

  it.each(['test', 'production'])(
    'never logs a message with NODE_ENV=%s',
    async (nodeEnv) => {
      const log = vi
        .spyOn(Logger.prototype, 'log')
        .mockImplementation(() => {});
      await provider(nodeEnv).send(message);
      expect(log).not.toHaveBeenCalled();
    },
  );

  it('never prints the body of a message that holds personal data', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    await provider('development').send({
      ...message,
      body: 'Name: Asha Rao\nPhone: +919876543210',
      personal: true,
    });

    const line = String(log.mock.calls[0][0]);
    expect(line).not.toContain('Asha Rao');
    expect(line).not.toContain('+919876543210');
    expect(line).toContain('not printed');
  });

  it('still keeps every message for the outbox', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    const mock = provider('test');
    await mock.send(message);
    expect(mock.messagesTo('asha@example.com')).toHaveLength(1);
  });
});

describe('maskRecipient', () => {
  it.each([
    ['asha@example.com', 'a***@example.com'],
    ['+919876543210', '+91******3210'],
    ['1234567', '*****67'],
    ['12345', '****45'],
    ['@example.com', '***@example.com'],
  ])('masks %s as %s', (to, masked) => {
    expect(maskRecipient(to)).toBe(masked);
  });
});

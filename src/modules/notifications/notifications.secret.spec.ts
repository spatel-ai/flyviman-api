import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  MessagingProvider,
  OutboundMessage,
} from '../../integrations/messaging/messaging.provider.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { NotificationsService } from './notifications.service.js';

/** A provider whose delivery finishes only when the test says so. */
function setup() {
  let finish!: (outcome: 'sent' | 'failed') => void;
  const handed: OutboundMessage[] = [];
  const messaging = {
    send: (message: OutboundMessage) => {
      handed.push(message);
      return new Promise((resolve, reject) => {
        finish = (outcome) =>
          outcome === 'sent'
            ? resolve({ providerMessageId: 'smtp-1' })
            : reject(new Error('550 asha@gmail.com unavailable'));
      });
    },
  } as unknown as MessagingProvider;
  const logged: { status: string; payload: unknown }[] = [];
  const prisma = {
    notification: {
      create: async ({
        data,
      }: {
        data: { status: string; payload: unknown };
      }) => {
        logged.push({ status: data.status, payload: data.payload });
        return {};
      },
    },
    notificationTemplate: { findUnique: async () => null },
  } as unknown as PrismaService;
  return {
    service: new NotificationsService(prisma, messaging),
    handed,
    logged,
    finish: (outcome: 'sent' | 'failed') => finish(outcome),
  };
}

const reset = {
  userId: 'u-1',
  channel: 'EMAIL' as const,
  templateKey: 'auth.password_reset',
  to: 'asha@gmail.com',
  secret: true,
  variables: { link: 'https://flyviman.test/reset?token=t', minutes: 30 },
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => vi.restoreAllMocks());

describe('NotificationsService.send with a code or link', () => {
  it('hands the message to the provider and returns before delivery finishes', async () => {
    const { service, handed, logged, finish } = setup();
    await service.send(reset);

    // Handed over (the dev outbox records it at this point), not yet delivered.
    expect(handed).toHaveLength(1);
    expect(handed[0].to).toBe('asha@gmail.com');
    expect(logged).toHaveLength(0);

    finish('sent');
    await settle();
    expect(logged).toEqual([{ status: 'SENT', payload: {} }]);
  });

  it('logs and records a failed delivery without the recipient or the link', async () => {
    const error = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    const { service, logged, finish } = setup();
    await service.send(reset);

    finish('failed');
    await settle();
    expect(logged).toEqual([{ status: 'FAILED', payload: {} }]);
    const line = error.mock.calls.flat().join(' ');
    expect(line).toContain('auth.password_reset');
    expect(line).not.toContain('asha');
    expect(line).not.toContain('token');
  });
});

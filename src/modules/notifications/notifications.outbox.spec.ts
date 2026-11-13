import { describe, expect, it } from 'vitest';
import type { MessagingProvider } from '../../integrations/messaging/messaging.provider.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { NotificationsService } from './notifications.service.js';

type Row = {
  id: string;
  status: 'QUEUED' | 'SENT' | 'FAILED';
  channel: 'EMAIL';
  templateKey: string;
  payload: Record<string, string | number>;
  recipient: string | null;
  attempts: number;
  nextAttemptAt: Date | null;
  providerMessageId?: string;
};

/** One queued row and just enough of Prisma's notification API around it. */
function setup(options: { failSends?: number; failRecords?: number } = {}) {
  const row: Row = {
    id: 'n-1',
    status: 'QUEUED',
    channel: 'EMAIL',
    templateKey: 'document.expiring',
    payload: {
      document: 'Insurance',
      subject: 'VT-ABC',
      date: '1 Dec 2026',
      when: 'in 5 days',
    },
    recipient: 'ops@example.com',
    attempts: 0,
    nextAttemptAt: new Date(Date.now() - 1000),
  };
  let recordFailures = options.failRecords ?? 0;
  const matches = (where: Record<string, unknown>) => {
    if (where.status && where.status !== row.status) return false;
    const due = where.nextAttemptAt as { lte?: Date } | undefined;
    if (due?.lte && (!row.nextAttemptAt || row.nextAttemptAt > due.lte)) {
      return false;
    }
    return true;
  };
  const prisma = {
    notification: {
      // Applied atomically, like a conditional UPDATE in PostgreSQL.
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        if (data.status === 'SENT' && recordFailures > 0) {
          recordFailures -= 1;
          throw new Error('database blip');
        }
        if (!matches(where)) return { count: 0 };
        for (const [key, value] of Object.entries(data)) {
          if (key === 'attempts' && typeof value === 'object') {
            row.attempts += 1;
          } else {
            (row as Record<string, unknown>)[key] = value;
          }
        }
        return { count: 1 };
      },
      findUnique: async () => ({ ...row }),
    },
    notificationTemplate: { findUnique: async () => null },
  } as unknown as PrismaService;
  let failures = options.failSends ?? 0;
  const sent: string[] = [];
  const messaging = {
    send: async (message: { to: string; subject?: string }) => {
      // Let the other caller run between the claim and the send.
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (failures > 0) {
        failures -= 1;
        throw new Error('provider down');
      }
      sent.push(message.subject ?? '');
      return { providerMessageId: `msg-${sent.length}` };
    },
  } as unknown as MessagingProvider;
  return { service: new NotificationsService(prisma, messaging), row, sent };
}

describe('notification outbox', () => {
  it('sends a message once when two senders reach it together', async () => {
    const { service, row, sent } = setup();
    await Promise.all([service.deliver(row.id), service.deliver(row.id)]);
    expect(sent).toEqual(['Insurance for VT-ABC expires in 5 days']);
    expect(row.status).toBe('SENT');
    // A sent message keeps no address.
    expect(row.recipient).toBeNull();
  });

  it('schedules a retry after a failure, then fails for good', async () => {
    const { service, row, sent } = setup({ failSends: 10 });
    await service.deliver(row.id);
    expect(row.status).toBe('QUEUED');
    expect(row.attempts).toBe(1);
    expect(row.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + 50_000);

    // Each later attempt is made once it is due.
    for (let attempt = 2; attempt <= 5; attempt += 1) {
      row.nextAttemptAt = new Date(Date.now() - 1000);
      await service.deliver(row.id);
    }
    expect(sent).toEqual([]);
    expect(row.status).toBe('FAILED');
    expect(row.attempts).toBe(5);
    expect(row.recipient).toBeNull();
  });

  it('leaves a message that is not yet due to the dispatcher', async () => {
    const { service, row, sent } = setup();
    row.nextAttemptAt = new Date(Date.now() + 60_000);
    await service.deliver(row.id);
    expect(sent).toEqual([]);
    expect(row.status).toBe('QUEUED');
  });

  it('never sends again when only recording the send failed', async () => {
    const { service, row, sent } = setup({ failRecords: 1 });
    await service.deliver(row.id);
    expect(sent).toHaveLength(1);
    expect(row.status).toBe('SENT');
    // Even once due again, it is not resent.
    row.nextAttemptAt = new Date(Date.now() - 1000);
    await service.deliver(row.id);
    expect(sent).toHaveLength(1);
  });
});

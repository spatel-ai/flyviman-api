import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '../../../generated/prisma/client.js';
import type { OperatorsService } from '../../operators/operators.service.js';
import type { UsersService } from '../../users/users.service.js';
import type { NotificationsService } from '../notifications.service.js';
import { NotificationEventsService } from './notification-events.service.js';

const tx = {} as Prisma.TransactionClient;

function build(whatsapp = true) {
  const enqueue = vi.fn().mockResolvedValue('id');
  const users = {
    contacts: vi.fn(),
    contactsByRole: vi.fn(),
  };
  const operators = { bookingRecipients: vi.fn() };
  const config = {
    get: (key: string) => (key === 'WHATSAPP_ENABLED' ? whatsapp : undefined),
    getOrThrow: (key: string) =>
      key === 'WEB_ORIGIN' ? 'https://flyviman.test' : 'ops@flyviman.test',
  };
  const service = new NotificationEventsService(
    { enqueue } as unknown as NotificationsService,
    users as unknown as UsersService,
    operators as unknown as OperatorsService,
    config as unknown as ConfigService,
  );
  const sent = () =>
    enqueue.mock.calls.map(([input]) => ({
      channel: input.channel as string,
      userId: input.userId as string | undefined,
      to: input.to as string | undefined,
      variables: input.variables as Record<string, string>,
    }));
  return { service, users, operators, sent, enqueue };
}

describe('NotificationEventsService', () => {
  it('tells a customer over every channel they can be reached on', async () => {
    const { service, users, sent } = build();
    users.contacts.mockResolvedValue([
      { id: 'c1', email: 'a@example.com', phone: '+919800000001' },
    ]);
    await service.notify(tx, 'booking.quote_sent', {
      reference: 'FV-1',
      customerId: 'c1',
      variables: { validUntil: '21 Nov' },
    });
    expect(sent().map((m) => [m.channel, m.to])).toEqual([
      ['IN_APP', undefined],
      ['EMAIL', 'a@example.com'],
      ['SMS', '+919800000001'],
      ['WHATSAPP', '+919800000001'],
    ]);
    expect(sent()[0].variables).toMatchObject({
      reference: 'FV-1',
      validUntil: '21 Nov',
      href: '/account/trips/FV-1',
      link: 'https://flyviman.test/account/trips/FV-1',
    });
  });

  it('skips SMS and WhatsApp without a verified phone, and WhatsApp when it is off', async () => {
    const quiet = build();
    quiet.users.contacts.mockResolvedValue([
      { id: 'c1', email: 'a@example.com', phone: null },
    ]);
    await quiet.service.notify(tx, 'payment.failed', {
      reference: 'FV-1',
      customerId: 'c1',
    });
    expect(quiet.sent().map((m) => m.channel)).toEqual(['IN_APP', 'EMAIL']);

    const noWhatsapp = build(false);
    noWhatsapp.users.contacts.mockResolvedValue([
      { id: 'c1', email: 'a@example.com', phone: '+919800000001' },
    ]);
    await noWhatsapp.service.notify(tx, 'payment.failed', {
      reference: 'FV-1',
      customerId: 'c1',
    });
    expect(noWhatsapp.sent().map((m) => m.channel)).toEqual([
      'IN_APP',
      'EMAIL',
      'SMS',
    ]);
  });

  it('tells only the operator team that may handle the aircraft', async () => {
    const { service, users, operators, sent } = build();
    operators.bookingRecipients.mockResolvedValue(['o1', 'o2']);
    users.contacts.mockResolvedValue([
      { id: 'o1', email: 'admin@op.test', phone: null },
      { id: 'o2', email: 'staff@op.test', phone: null },
    ]);
    await service.notify(tx, 'booking.quote_accepted', {
      reference: 'FV-1',
      operatorId: 'op',
      aircraftId: 'ac',
    });
    expect(operators.bookingRecipients).toHaveBeenCalledWith('op', 'ac');
    expect(sent().map((m) => [m.userId, m.channel])).toEqual([
      ['o1', 'IN_APP'],
      ['o1', 'EMAIL'],
      ['o2', 'IN_APP'],
      ['o2', 'EMAIL'],
    ]);
    expect(sent()[0].variables.href).toBe('/operator/requests/FV-1');
  });

  it('sends operations in-app and phone messages, and one email to the inbox', async () => {
    const { service, users, sent } = build();
    users.contactsByRole.mockResolvedValue([
      { id: 'p1', email: 'ops1@flyviman.test', phone: '+919800000002' },
    ]);
    await service.notify(tx, 'air_ambulance.received', { reference: 'AA-1' });
    expect(sent().map((m) => [m.userId, m.channel, m.to])).toEqual([
      ['p1', 'IN_APP', undefined],
      ['p1', 'SMS', '+919800000002'],
      ['p1', 'WHATSAPP', '+919800000002'],
      [undefined, 'EMAIL', 'ops@flyviman.test'],
    ]);
    expect(JSON.stringify(sent())).not.toMatch(/patient|medical/i);
  });

  it('queues nothing for a recipient that is missing', async () => {
    const { service, enqueue } = build();
    await service.notify(tx, 'booking.quote_sent', { reference: 'FV-1' });
    await service.notify(tx, 'booking.requested', {
      reference: 'FV-1',
      operatorId: null,
    });
    expect(enqueue).not.toHaveBeenCalled();
  });
});

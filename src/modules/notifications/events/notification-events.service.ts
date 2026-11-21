import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type NotificationChannel,
  Role,
} from '../../../generated/prisma/enums.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { OperatorsService } from '../../operators/operators.service.js';
import { type ContactRow, UsersService } from '../../users/users.service.js';
import { channelsFor, hrefFor, optedOutChannels, ruleFor } from '../matrix.js';
import { NotificationsService } from '../notifications.service.js';

export interface EventContext {
  reference: string;
  /** For a customer rule: the account that booked or asked. */
  customerId?: string;
  /** For an operator rule: whose aircraft, so only its team is told. */
  operatorId?: string | null;
  aircraftId?: string | null;
  /**
   * The booking has been confirmed (`confirmedAt` set): the operator's link
   * then leads to its bookings page rather than the request inbox.
   */
  confirmed?: boolean;
  /** System-derived values only (`validUntil`, `decision`): never free text. */
  variables?: Record<string, string | number>;
}

interface Contact {
  /** Null for an address that is not an account (the operations inbox). */
  userId: string | null;
  email: string | null;
  phone: string | null;
  /** The non-mandatory channels this recipient opted out of. */
  optedOut: NotificationChannel[];
}

/**
 * Raises a matrix event (M10): looks up who is told, what channels they get
 * and queues each message in the outbox, inside the caller's transaction, so
 * a message is sent if and only if the change commits. The dispatcher sends
 * them; a caller with a post-commit point may `deliver` the returned ids.
 */
@Injectable()
export class NotificationEventsService {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly users: UsersService,
    private readonly operators: OperatorsService,
    private readonly config: ConfigService,
  ) {}

  async notify(
    tx: Prisma.TransactionClient,
    key: string,
    context: EventContext,
  ): Promise<string[]> {
    const rule = ruleFor(key);
    const whatsappEnabled =
      this.config.get<boolean>('WHATSAPP_ENABLED') ?? false;
    const href = hrefFor(rule, context.reference, {
      confirmed: context.confirmed ?? false,
    });
    const origin = this.config.getOrThrow<string>('WEB_ORIGIN');
    const variables = {
      ...context.variables,
      reference: context.reference,
      href,
      link: `${origin}${href}`,
    };

    const ids: string[] = [];
    for (const contact of await this.recipients(rule.audience, context)) {
      const channels = channelsFor(rule, {
        whatsappEnabled,
        optedOut: contact.optedOut,
      });
      for (const channel of channels) {
        const to = this.addressFor(channel, contact, rule.audience);
        if (to === undefined) continue;
        ids.push(
          await this.notifications.enqueue(
            {
              userId: contact.userId ?? undefined,
              channel,
              templateKey: key,
              variables,
              to: to ?? undefined,
            },
            tx,
          ),
        );
      }
    }
    return ids;
  }

  /** `notify` for a booking by id: its customer and operator are read here. */
  async notifyBooking(
    tx: Prisma.TransactionClient,
    key: string,
    bookingId: string,
    variables?: Record<string, string | number>,
  ): Promise<string[]> {
    const booking = await tx.booking.findUniqueOrThrow({
      where: { id: bookingId },
      select: {
        reference: true,
        customerId: true,
        operatorId: true,
        aircraftId: true,
        confirmedAt: true,
      },
    });
    const { confirmedAt, ...context } = booking;
    return this.notify(tx, key, {
      ...context,
      confirmed: confirmedAt !== null,
      variables,
    });
  }

  /**
   * Where a channel goes for a contact: `null` for in-app (no address),
   * `undefined` when the contact has none or the channel is not theirs.
   * Operations users get in-app and phone messages; email goes to the
   * shared inbox only, so a request is not mailed to everyone.
   */
  private addressFor(
    channel: NotificationChannel,
    contact: Contact,
    audience: string,
  ): string | null | undefined {
    const inbox = contact.userId === null;
    if (channel === 'IN_APP') return inbox ? undefined : null;
    if (channel === 'EMAIL') {
      if (audience === 'OPERATIONS' && !inbox) return undefined;
      return contact.email ?? undefined;
    }
    return inbox ? undefined : (contact.phone ?? undefined);
  }

  private async recipients(
    audience: string,
    context: EventContext,
  ): Promise<Contact[]> {
    if (audience === 'CUSTOMER') {
      if (!context.customerId) return [];
      return this.accounts(await this.users.contacts([context.customerId]));
    }
    if (audience === 'OPERATOR') {
      if (!context.operatorId) return [];
      const ids = await this.operators.bookingRecipients(
        context.operatorId,
        context.aircraftId ?? null,
      );
      return this.accounts(await this.users.contacts(ids));
    }
    return [
      ...this.accounts(await this.users.contactsByRole(Role.OPS)),
      {
        userId: null,
        email: this.config.getOrThrow<string>('OPERATIONS_INBOX_EMAIL'),
        phone: null,
        optedOut: [],
      },
    ];
  }

  private accounts(rows: ContactRow[]): Contact[] {
    return rows.map((row) => ({
      userId: row.id,
      email: row.email,
      phone: row.phone,
      optedOut: optedOutChannels(row),
    }));
  }
}

import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Paginated } from '../../common/dto/paginated.js';
import { AppException } from '../../common/errors/app.exception.js';
import {
  NotificationChannel,
  NotificationStatus,
} from '../../generated/prisma/enums.js';
import {
  type MessageChannel,
  MessagingProvider,
} from '../../integrations/messaging/messaging.provider.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { DEFAULT_TEMPLATES, render } from './templates.js';

type Variables = Record<string, string | number>;

/** Outbox (D-072): how often it is checked, how much per pass, how often retried. */
const OUTBOX_INTERVAL_MS = 10_000;
const OUTBOX_BATCH = 20;
const OUTBOX_MAX_ATTEMPTS = 5;
/** How long a claimed row is held before another sender may take it. */
const OUTBOX_LEASE_SECONDS = 300;

export interface SendNotification {
  /**
   * Who it is for. Leave out only for a message to someone with no account
   * yet (a registration code): it is sent but not written to the log.
   */
  userId?: string;
  channel: NotificationChannel;
  templateKey: string;
  variables?: Variables;
  /** Email address or E.164 phone number. Not needed for IN_APP. */
  to?: string;
  /**
   * Set for messages carrying a one-time password or a reset link: the
   * variables are used to render the message and are not stored.
   */
  secret?: boolean;
}

export interface InAppNotification {
  id: string;
  templateKey: string;
  title: string;
  body: string;
  readAt: Date | null;
  createdAt: Date;
}

/**
 * Renders templates, sends through the messaging adapter and keeps the
 * delivery log, which doubles as the in-app inbox. Never pass medical data.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly messaging: MessagingProvider,
  ) {}

  /**
   * Sends one notification now. A delivery failure is recorded and logged,
   * not thrown: the action that triggered the message has already happened.
   * Call it after the triggering transaction commits. A message without a
   * code or link that fails is kept QUEUED and retried by the outbox (D-072);
   * one with a code or link is never stored, so it cannot be retried.
   */
  async send(input: SendNotification): Promise<void> {
    const userId = input.userId;
    if (
      !input.secret &&
      userId &&
      input.to &&
      input.channel !== NotificationChannel.IN_APP
    ) {
      // Never thrown to the caller, whose change has already committed.
      try {
        const id = await this.enqueue({ ...input, userId });
        await this.deliver(id);
      } catch (error) {
        this.logFailure(input.templateKey, input.channel, error);
      }
      return;
    }
    const variables = input.variables ?? {};
    const log = (data: {
      status: NotificationStatus;
      providerMessageId?: string;
    }) =>
      userId
        ? this.prisma.notification.create({
            data: {
              channel: input.channel,
              templateKey: input.templateKey,
              payload: input.secret ? {} : variables,
              userId,
              ...data,
            },
          })
        : Promise.resolve();

    try {
      if (input.channel === NotificationChannel.IN_APP) {
        await log({ status: NotificationStatus.SENT });
        return;
      }
      if (!input.to) throw new Error('No recipient address');
      const sent = await this.dispatchMessage(
        input.channel as MessageChannel,
        input.templateKey,
        variables,
        input.to,
      );
      await log({
        status: NotificationStatus.SENT,
        providerMessageId: sent.providerMessageId,
      });
    } catch (error) {
      this.logFailure(input.templateKey, input.channel, error);
      await log({ status: NotificationStatus.FAILED }).catch(() => undefined);
    }
  }

  /**
   * Writes a notification to the outbox, inside the caller's transaction
   * when one is given, so it is sent if and only if the change commits and
   * survives a crash before delivery (D-072). In-app messages are the log
   * itself and are written as sent. Never for a message with a code or link.
   * Returns the row id; delivery follows from the dispatcher, or at once
   * with `deliver(id)` after the commit.
   */
  async enqueue(
    input: Omit<SendNotification, 'secret'> & { userId: string },
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<string> {
    if (input.channel !== NotificationChannel.IN_APP && !input.to) {
      throw new Error('No recipient address');
    }
    const row = await db.notification.create({
      data: {
        userId: input.userId,
        channel: input.channel,
        templateKey: input.templateKey,
        payload: input.variables ?? {},
        ...(input.channel === NotificationChannel.IN_APP
          ? { status: NotificationStatus.SENT }
          : {
              status: NotificationStatus.QUEUED,
              recipient: input.to,
              nextAttemptAt: new Date(),
            }),
      },
      select: { id: true },
    });
    return row.id;
  }

  /**
   * Delivers queued messages that are due, a batch at a time. Each row is
   * leased first (SKIP LOCKED, `nextAttemptAt` pushed past the lease), so two
   * instances, or the dispatcher and an immediate send, never send the same
   * message, and a crash mid-send only delays it.
   */
  @Interval('notification-outbox', OUTBOX_INTERVAL_MS)
  async dispatchDue(): Promise<number> {
    let claimed: { id: string }[];
    try {
      claimed = await this.prisma.$queryRaw<{ id: string }[]>`
        UPDATE "Notification"
        SET "nextAttemptAt" = now() + make_interval(secs => ${OUTBOX_LEASE_SECONDS}),
            "updatedAt" = now()
        WHERE id IN (
          SELECT id FROM "Notification"
          WHERE status = 'QUEUED' AND "nextAttemptAt" <= now()
          ORDER BY "nextAttemptAt"
          LIMIT ${OUTBOX_BATCH}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id`;
    } catch (error) {
      this.logger.error(
        `Outbox claim failed: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
      return 0;
    }
    for (const { id } of claimed) await this.sendLeased(id);
    return claimed.length;
  }

  /**
   * Sends one queued message now, if no one else holds it: the row is leased
   * by a conditional update first, so this and the dispatcher cannot both
   * send it. Never throws.
   */
  async deliver(id: string): Promise<void> {
    try {
      const { count } = await this.prisma.notification.updateMany({
        where: {
          id,
          status: NotificationStatus.QUEUED,
          nextAttemptAt: { lte: new Date() },
        },
        data: {
          nextAttemptAt: new Date(Date.now() + OUTBOX_LEASE_SECONDS * 1000),
        },
      });
      if (count === 1) await this.sendLeased(id);
    } catch (error) {
      this.logger.error(
        `Outbox delivery failed: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
    }
  }

  /**
   * Sends a row this instance has leased. Success marks it SENT; a failure
   * schedules a retry (1, 2, 4, 8 minutes), then marks it FAILED. A finished
   * row keeps no address (the outbox needs it only while QUEUED).
   */
  private async sendLeased(id: string): Promise<void> {
    const row = await this.prisma.notification.findUnique({ where: { id } });
    if (
      !row ||
      row.status !== NotificationStatus.QUEUED ||
      !row.recipient ||
      row.channel === NotificationChannel.IN_APP
    ) {
      return;
    }
    try {
      const sent = await this.dispatchMessage(
        row.channel,
        row.templateKey,
        (row.payload ?? {}) as Variables,
        row.recipient,
      );
      await this.prisma.notification.updateMany({
        where: { id, status: NotificationStatus.QUEUED },
        data: {
          status: NotificationStatus.SENT,
          providerMessageId: sent.providerMessageId,
          attempts: { increment: 1 },
          nextAttemptAt: null,
          recipient: null,
        },
      });
    } catch (error) {
      this.logFailure(row.templateKey, row.channel, error);
      const attempts = row.attempts + 1;
      await this.prisma.notification
        .updateMany({
          where: { id, status: NotificationStatus.QUEUED },
          data:
            attempts >= OUTBOX_MAX_ATTEMPTS
              ? {
                  status: NotificationStatus.FAILED,
                  attempts,
                  nextAttemptAt: null,
                  recipient: null,
                }
              : {
                  attempts,
                  nextAttemptAt: new Date(
                    Date.now() + 60_000 * 2 ** (attempts - 1),
                  ),
                },
        })
        .catch(() => undefined);
    }
  }

  private async dispatchMessage(
    channel: MessageChannel,
    templateKey: string,
    variables: Variables,
    to: string,
  ) {
    const template = await this.template(templateKey, channel);
    return this.messaging.send({
      channel,
      to,
      subject: template.subject
        ? render(template.subject, variables)
        : undefined,
      body: render(template.body, variables),
    });
  }

  private logFailure(
    templateKey: string,
    channel: NotificationChannel,
    error: unknown,
  ): void {
    // Template key and channel only: recipients and content stay out of logs.
    // A provider's error text can repeat the recipient, so only its name
    // is logged.
    this.logger.error(
      `Notification ${templateKey} over ${channel} failed: ${
        error instanceof Error ? error.name : 'unknown error'
      }`,
    );
  }

  async listInApp(
    userId: string,
    page: number,
    pageSize: number,
  ): Promise<Paginated<InAppNotification>> {
    const where = { userId, channel: NotificationChannel.IN_APP };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.notification.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.notification.count({ where }),
    ]);
    const items = await Promise.all(rows.map((row) => this.present(row)));
    return new Paginated(items, page, pageSize, total);
  }

  async markRead(userId: string, id: string): Promise<InAppNotification> {
    // Scoped to the owner: another user's notification is simply not found.
    const row = await this.prisma.notification.findFirst({
      where: { id, userId, channel: NotificationChannel.IN_APP },
    });
    if (!row) {
      throw new AppException(
        'NOT_FOUND',
        'Notification not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    const updated = row.readAt
      ? row
      : await this.prisma.notification.update({
          where: { id },
          data: { readAt: new Date() },
        });
    return this.present(updated);
  }

  private async present(row: {
    id: string;
    templateKey: string;
    payload: unknown;
    readAt: Date | null;
    createdAt: Date;
  }): Promise<InAppNotification> {
    const template = await this.template(
      row.templateKey,
      NotificationChannel.IN_APP,
    );
    const variables = (row.payload ?? {}) as Variables;
    return {
      id: row.id,
      templateKey: row.templateKey,
      title: render(template.subject ?? '', variables),
      body: render(template.body, variables),
      readAt: row.readAt,
      createdAt: row.createdAt,
    };
  }

  private async template(
    key: string,
    channel: NotificationChannel,
  ): Promise<{ subject?: string | null; body: string }> {
    const stored = await this.prisma.notificationTemplate.findUnique({
      where: { key_channel: { key, channel } },
    });
    if (stored?.isActive) return stored;
    const builtIn = DEFAULT_TEMPLATES.find(
      (template) => template.key === key && template.channel === channel,
    );
    if (!builtIn) {
      throw new Error(`No notification template for ${key} over ${channel}`);
    }
    return builtIn;
  }
}

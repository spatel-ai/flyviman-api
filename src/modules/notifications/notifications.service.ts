import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Paginated } from '../../common/dto/paginated.js';
import { AppException } from '../../common/errors/app.exception.js';
import {
  NotificationChannel,
  NotificationStatus,
} from '../../generated/prisma/enums.js';
import { MessagingProvider } from '../../integrations/messaging/messaging.provider.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { DEFAULT_TEMPLATES, render } from './templates.js';

type Variables = Record<string, string | number>;

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
   * Sends one notification. A delivery failure is recorded and logged, not
   * thrown: the action that triggered the message has already happened.
   * Call it after the triggering transaction commits.
   */
  async send(input: SendNotification): Promise<void> {
    const variables = input.variables ?? {};
    const template = await this.template(input.templateKey, input.channel);
    const userId = input.userId;
    const log = (data: {
      status: NotificationStatus;
      providerMessageId?: string;
    }) =>
      userId
        ? this.prisma.notification.create({
            data: { ...base, userId, ...data },
          })
        : Promise.resolve();
    const base = {
      channel: input.channel,
      templateKey: input.templateKey,
      payload: input.secret ? {} : variables,
    };

    try {
      if (input.channel === NotificationChannel.IN_APP) {
        await log({ status: NotificationStatus.SENT });
        return;
      }
      if (!input.to) throw new Error('No recipient address');
      const sent = await this.messaging.send({
        channel: input.channel,
        to: input.to,
        subject: template.subject
          ? render(template.subject, variables)
          : undefined,
        body: render(template.body, variables),
      });
      await log({
        status: NotificationStatus.SENT,
        providerMessageId: sent.providerMessageId,
      });
    } catch (error) {
      // Template key and channel only: recipients and content stay out of logs.
      // A provider's error text can repeat the recipient, so only its name
      // is logged.
      this.logger.error(
        `Notification ${input.templateKey} over ${input.channel} failed: ${
          error instanceof Error ? error.name : 'unknown error'
        }`,
      );
      await log({ status: NotificationStatus.FAILED }).catch(() => undefined);
    }
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

import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException } from '../../common/errors/app.exception.js';
import { Paginated } from '../../common/dto/paginated.js';
import type { Enquiry, Prisma } from '../../generated/prisma/client.js';
import {
  EnquiryTopic,
  NotificationChannel,
} from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import type {
  CreateEnquiryDto,
  EnquiryResponseDto,
} from './dto/enquiry.dto.js';
import { enquiryReference } from './enquiry-reference.js';

/** How the topic reads in the email to operations. */
export const TOPIC_LABELS: Record<EnquiryTopic, string> = {
  GENERAL: 'General',
  PRIVATE_CHARTER: 'Private charter',
  CELEBRITY_CHARTER: 'Celebrity charter',
  ELECTION_CHARTER: 'Election charter',
  MARRIAGE_CHARTER: 'Marriage charter',
  PILGRIMAGE_CHARTER: 'Pilgrimage charter',
  MEDICAL_CHARTER: 'Medical charter',
  GROUP_CHARTER: 'Group charter',
  FLOWER_DROP_CHARTER: 'Flower drop charter',
  AIRCRAFT_SALES: 'Aircraft sales',
  CONSULTANCY: 'Consultancy',
  PILOT_JOBS: 'Pilot job assistance',
  PILOT_TRAINING: 'Pilot courses and training',
};

/** Attempts at a fresh reference before giving up (31^6 codes). */
const REFERENCE_ATTEMPTS = 5;

/**
 * Sales enquiries from the public contact page. Contact details and the
 * message are personal data: they go to the operations inbox and nowhere
 * else (not the audit trail, not the logs).
 */
@Injectable()
export class EnquiriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  async create(input: CreateEnquiryDto): Promise<EnquiryResponseDto> {
    if (!input.email && !input.phone) {
      throw new AppException(
        'VALIDATION_ERROR',
        'The request is not valid.',
        HttpStatus.BAD_REQUEST,
        [{ field: 'email', issue: 'send an email address or a phone number' }],
      );
    }

    for (let attempt = 1; ; attempt += 1) {
      try {
        const { enquiry, notificationId } = await this.prisma.$transaction(
          async (tx) => {
            const enquiry = await tx.enquiry.create({
              data: {
                reference: enquiryReference(),
                name: input.name,
                email: input.email ?? null,
                phone: input.phone ?? null,
                topic: input.topic,
                message: input.message,
              },
            });
            // The id and topic only: the rest is personal data.
            await this.audit.record(
              {
                action: 'enquiry.create',
                entityType: 'Enquiry',
                entityId: enquiry.id,
                after: { topic: enquiry.topic },
              },
              tx,
            );
            const notificationId = await this.notifications.enqueue(
              {
                channel: NotificationChannel.EMAIL,
                to: this.config.getOrThrow<string>('OPERATIONS_INBOX_EMAIL'),
                templateKey: 'enquiry.received',
                variables: {
                  reference: enquiry.reference,
                  topic: TOPIC_LABELS[enquiry.topic],
                  receivedAt: enquiry.createdAt.toISOString(),
                  name: enquiry.name,
                  email: enquiry.email ?? 'not given',
                  phone: enquiry.phone ?? 'not given',
                  message: enquiry.message,
                },
              },
              tx,
            );
            return { enquiry, notificationId };
          },
        );
        // Sent at once; the outbox retries it if this fails.
        await this.notifications.deliver(notificationId);
        return {
          reference: enquiry.reference,
          receivedAt: enquiry.createdAt.toISOString(),
        };
      } catch (error) {
        const clash =
          (error as { code?: unknown }).code === 'P2002' &&
          attempt < REFERENCE_ATTEMPTS;
        if (!clash) throw error;
      }
    }
  }

  // --- Administration -----------------------------------------------------

  async list(filter: {
    page: number;
    pageSize: number;
    handled?: boolean;
    topic?: EnquiryTopic;
  }): Promise<Paginated<Enquiry>> {
    const where: Prisma.EnquiryWhereInput = {
      topic: filter.topic,
      handledAt:
        filter.handled === undefined
          ? undefined
          : filter.handled
            ? { not: null }
            : null,
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.enquiry.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (filter.page - 1) * filter.pageSize,
        take: filter.pageSize,
      }),
      this.prisma.enquiry.count({ where }),
    ]);
    return new Paginated(items, filter.page, filter.pageSize, total);
  }

  async getDetail(id: string): Promise<Enquiry> {
    const row = await this.prisma.enquiry.findUnique({ where: { id } });
    if (!row) {
      throw new AppException(
        'NOT_FOUND',
        'Enquiry not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    return row;
  }

  /**
   * Marks an enquiry handled and audits it in the same transaction (the id
   * and topic only; the details are personal data). Already handled: returns
   * it unchanged, with no second audit record.
   */
  async markHandled(id: string): Promise<Enquiry> {
    return this.prisma.$transaction(async (tx) => {
      // Only the request that finds it unhandled changes it, so two at once
      // write one audit record.
      const { count } = await tx.enquiry.updateMany({
        where: { id, handledAt: null },
        data: { handledAt: new Date() },
      });
      const row = await tx.enquiry.findUnique({ where: { id } });
      if (!row) {
        throw new AppException(
          'NOT_FOUND',
          'Enquiry not found.',
          HttpStatus.NOT_FOUND,
        );
      }
      if (count === 1) {
        await this.audit.record(
          {
            action: 'enquiry.handle',
            entityType: 'Enquiry',
            entityId: id,
            before: { topic: row.topic, handled: false },
            after: { topic: row.topic, handled: true },
          },
          tx,
        );
      }
      return row;
    });
  }
}

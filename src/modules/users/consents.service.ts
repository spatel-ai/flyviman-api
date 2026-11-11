import { HttpStatus, Injectable } from '@nestjs/common';
import { requestContext } from '../../common/context/request-context.js';
import { AppException } from '../../common/errors/app.exception.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { ConsentType } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ContentService } from '../content/content.service.js';

/** The policy each consent type refers to, where there is one. */
const POLICY_SLUG: Partial<Record<ConsentType, string>> = {
  [ConsentType.TERMS]: 'terms',
  [ConsentType.PRIVACY]: 'privacy',
};

export interface ConsentRecord {
  type: ConsentType;
  version: string;
  acceptedAt: Date;
}

@Injectable()
export class ConsentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly content: ContentService,
  ) {}

  /**
   * Records an acceptance. For terms and privacy the version is always the
   * policy currently published, so a client cannot record consent to a
   * version the user was not shown.
   */
  async record(
    userId: string,
    type: ConsentType,
    version?: string,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<ConsentRecord> {
    const slug = POLICY_SLUG[type];
    const resolved = slug
      ? (await this.content.findPolicy(slug))?.version
      : version;
    if (!resolved) {
      throw new AppException(
        'VALIDATION_ERROR',
        slug
          ? 'This policy is not published yet.'
          : 'A version is required for this consent.',
        HttpStatus.BAD_REQUEST,
        [{ field: 'version', issue: 'is required' }],
      );
    }
    return db.consent.create({
      data: {
        userId,
        type,
        version: resolved,
        ipAddress: requestContext.get()?.ipAddress ?? null,
      },
      select: { type: true, version: true, acceptedAt: true },
    });
  }

  /** Terms and privacy together, as accepted at registration. */
  async recordRegistration(
    userId: string,
    db: Prisma.TransactionClient,
  ): Promise<void> {
    await this.record(userId, ConsentType.TERMS, undefined, db);
    await this.record(userId, ConsentType.PRIVACY, undefined, db);
  }
}

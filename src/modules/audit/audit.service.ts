import { Injectable } from '@nestjs/common';
import { requestContext } from '../../common/context/request-context.js';
import { Paginated } from '../../common/dto/paginated.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { Role } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';

export interface AuditEntry {
  /** Dotted and stable, for example `operator.approve`. */
  action: string;
  entityType: string;
  entityId: string;
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
  reason?: string;
  /** Defaults to the signed-in caller. Pass it for sign-in itself. */
  actor?: { id: string; role: Role } | null;
}

export interface AuditLogFilter {
  page: number;
  pageSize: number;
  entityType?: string;
  entityId?: string;
  actorId?: string;
  action?: string;
  from?: Date;
  to?: Date;
}

export type AuditLogRecord = Prisma.AuditLogGetPayload<object>;

/**
 * Writes and reads the append-only audit trail. Never put passwords, tokens,
 * medical details or card data in `before`, `after` or `reason`.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records one action. Pass the transaction client as `db` when the audited
   * change runs in a transaction, so the two commit or roll back together.
   */
  async record(
    entry: AuditEntry,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    const context = requestContext.get();
    const actor = entry.actor === undefined ? context?.actor : entry.actor;

    await db.auditLog.create({
      data: {
        actorId: actor?.id ?? null,
        actorRole: actor?.role ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        before: entry.before,
        after: entry.after,
        reason: entry.reason ?? null,
        ipAddress: context?.ipAddress ?? null,
        requestId: context?.requestId ?? null,
      },
    });
  }

  async list(filter: AuditLogFilter): Promise<Paginated<AuditLogRecord>> {
    const where: Prisma.AuditLogWhereInput = {
      entityType: filter.entityType,
      entityId: filter.entityId,
      actorId: filter.actorId,
      action: filter.action,
      createdAt:
        filter.from || filter.to
          ? { gte: filter.from, lte: filter.to }
          : undefined,
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (filter.page - 1) * filter.pageSize,
        take: filter.pageSize,
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return new Paginated(items, filter.page, filter.pageSize, total);
  }
}

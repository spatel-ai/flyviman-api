import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { EmptyLegStatus } from '../../generated/prisma/enums.js';

/**
 * Read-only figures about empty-leg offers for the reports module (W5-1),
 * which may not read this module's tables itself.
 */
@Injectable()
export class EmptyLegReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Offers created in the period: by current status, published, interests. */
  async summary(
    createdAt: { gte: Date; lt: Date },
    operatorId?: string,
  ): Promise<{
    byStatus: { status: EmptyLegStatus; count: number }[];
    published: number;
    interests: number;
  }> {
    const where = { createdAt, ...(operatorId ? { operatorId } : {}) };
    const [byStatus, published, interests] = await Promise.all([
      this.prisma.emptyLeg.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
      }),
      this.prisma.emptyLeg.count({
        where: { ...where, publishedAt: { not: null } },
      }),
      this.prisma.emptyLegInterest.count({ where: { emptyLeg: where } }),
    ]);
    return {
      byStatus: byStatus.map((row) => ({
        status: row.status,
        count: row._count._all,
      })),
      published,
      interests,
    };
  }
}

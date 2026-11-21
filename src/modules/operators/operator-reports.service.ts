import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  OperatorStatus,
  type OperatorStatus as OperatorStatusValue,
} from '../../generated/prisma/enums.js';

/**
 * Read-only figures about operators for the reports module (W5-1), which
 * may not read this module's tables itself. Business names only, never
 * contact details.
 */
@Injectable()
export class OperatorReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async statusCounts(): Promise<
    { status: OperatorStatusValue; count: number }[]
  > {
    const rows = await this.prisma.operator.groupBy({
      by: ['status'],
      _count: { _all: true },
    });
    return rows.map((row) => ({ status: row.status, count: row._count._all }));
  }

  pendingReviewCount(): Promise<number> {
    return this.prisma.operator.count({
      where: { status: OperatorStatus.PENDING_REVIEW },
    });
  }

  /** Each operator's trading name (else legal name) and status, by id. */
  async names(
    ids: string[],
  ): Promise<Map<string, { name: string; status: OperatorStatusValue }>> {
    const rows = await this.prisma.operator.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, legalName: true, tradingName: true, status: true },
    });
    return new Map(
      rows.map((row) => [
        row.id,
        { name: row.tradingName ?? row.legalName, status: row.status },
      ]),
    );
  }
}

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';

/** A calculation's split, for the finance reports (W5-1). Paise. */
export interface CalculationSplit {
  currency: string;
  taxMinor: bigint;
  operatorPayableMinor: bigint;
  platformRevenueMinor: bigint;
}

/** Keeps each query's parameter list well inside PostgreSQL's limit. */
const CHUNK = 5000;

/**
 * Read-only access to price calculations for the reports module, which may
 * not read this module's table itself. Finance figures only: callers gate
 * them to finance and the super administrator.
 */
@Injectable()
export class PricingReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async splits(ids: string[]): Promise<Map<string, CalculationSplit>> {
    const result = new Map<string, CalculationSplit>();
    const unique = [...new Set(ids)];
    for (let start = 0; start < unique.length; start += CHUNK) {
      const rows = await this.prisma.priceCalculation.findMany({
        where: { id: { in: unique.slice(start, start + CHUNK) } },
        select: {
          id: true,
          currency: true,
          taxMinor: true,
          operatorPayableMinor: true,
          platformRevenueMinor: true,
        },
      });
      for (const { id, ...split } of rows) result.set(id, split);
    }
    return result;
  }
}

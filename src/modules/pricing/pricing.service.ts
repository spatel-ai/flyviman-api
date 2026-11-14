import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { PriceType } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { EngineResult } from './engine.js';
import type { RuleRow } from './rules.js';

@Injectable()
export class PricingService {
  constructor(private readonly prisma: PrismaService) {}

  /** Every rule in force now. The table is small; callers resolve per aircraft. */
  async activeRules(now = new Date()): Promise<RuleRow[]> {
    return this.prisma.pricingRule.findMany({
      where: {
        isActive: true,
        validFrom: { lte: now },
        OR: [{ validTo: null }, { validTo: { gt: now } }],
      },
      select: {
        id: true,
        scope: true,
        scopeRef: true,
        type: true,
        config: true,
        priority: true,
        version: true,
      },
      // A fixed order, so resolving rules never depends on row order.
      orderBy: [{ scope: 'asc' }, { type: 'asc' }, { version: 'desc' }],
    });
  }

  /** Stores a priced result. Immutable from here on. */
  async saveCalculation(
    db: Prisma.TransactionClient,
    input: {
      searchId: string;
      aircraftId: string;
      operatorId: string;
      inputs: Prisma.InputJsonValue;
      result: EngineResult;
      availabilityCheckedAt: Date;
    },
  ): Promise<string> {
    const { result } = input;
    const row = await db.priceCalculation.create({
      data: {
        searchId: input.searchId,
        aircraftId: input.aircraftId,
        operatorId: input.operatorId,
        inputs: input.inputs,
        appliedRules: result.appliedRules as unknown as Prisma.InputJsonValue,
        breakdown: result.breakdown as unknown as Prisma.InputJsonValue,
        baseMinor: result.baseMinor,
        feesMinor: result.feesMinor,
        taxMinor: result.taxMinor,
        discountMinor: result.discountMinor,
        totalMinor: result.totalMinor,
        operatorPayableMinor: result.operatorPayableMinor,
        platformRevenueMinor: result.platformRevenueMinor,
        currency: result.currency,
        priceType: PriceType.ESTIMATE,
        validUntil: result.validUntil,
        availabilityCheckedAt: input.availabilityCheckedAt,
        assumptions: result.assumptions,
        exclusions: result.exclusions,
        warnings: result.warnings,
      },
      select: { id: true },
    });
    return row.id;
  }

  async calculation(id: string) {
    return this.prisma.priceCalculation.findUnique({ where: { id } });
  }
}

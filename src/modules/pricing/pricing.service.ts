import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import {
  type AircraftCategory,
  PriceType,
} from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { legMetrics, type EngineResult } from './engine.js';
import { priceOperatorQuote, type QuotePriceResult } from './quote-price.js';
import { resolveRules, type RuleRow } from './rules.js';

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

  /**
   * A leg's distance in kilometres for a category, after its routing factor,
   * from the platform and category rules alone (no aircraft or operator).
   */
  categoryLegKm(
    rules: RuleRow[],
    category: AircraftCategory,
    rawKm: number,
  ): number {
    return legMetrics(
      resolveRules(rules, { aircraftId: '', operatorId: '', category }),
      rawKm,
      null,
    ).distanceKm;
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

  /**
   * Prices an operator's quote (D-172 B) with the platform and category
   * rules in force for the aircraft, and stores the calculation, immutable
   * and labelled `QUOTE` (rule 1), in the caller's transaction. Returns the
   * stored id with the result.
   */
  async priceQuote(
    db: Prisma.TransactionClient,
    input: {
      aircraftId: string;
      operatorId: string;
      category: AircraftCategory;
      bookingId: string;
      operatorPriceMinor: number;
      validUntil: Date;
      availabilityCheckedAt: Date;
    },
  ): Promise<{ calculationId: string; result: QuotePriceResult }> {
    const rules = resolveRules(
      await this.activeRules(input.availabilityCheckedAt),
      {
        aircraftId: input.aircraftId,
        operatorId: input.operatorId,
        category: input.category,
      },
    );
    const result = priceOperatorQuote({
      operatorPriceMinor: input.operatorPriceMinor,
      rules,
    });
    const row = await db.priceCalculation.create({
      data: {
        searchId: null,
        aircraftId: input.aircraftId,
        operatorId: input.operatorId,
        // The operator's price is `baseMinor`, which only finance reads; it
        // is not repeated here, because operations see the inputs (D-103).
        inputs: {
          source: 'OPERATOR_QUOTE',
          bookingId: input.bookingId,
          category: input.category,
        },
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
        priceType: PriceType.QUOTE,
        validUntil: input.validUntil,
        availabilityCheckedAt: input.availabilityCheckedAt,
        assumptions: result.assumptions,
        exclusions: result.exclusions,
        warnings: result.warnings,
      },
      select: { id: true },
    });
    return { calculationId: row.id, result };
  }

  async calculation(id: string) {
    return this.prisma.priceCalculation.findUnique({ where: { id } });
  }
}

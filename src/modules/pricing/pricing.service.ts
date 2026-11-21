import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import {
  type AircraftCategory,
  PriceType,
} from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  type EngineResult,
  legMetrics,
  type PromotionInput,
} from './engine.js';
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
    input: CalculationInput,
  ): Promise<string> {
    const row = await db.priceCalculation.create({
      data: calculationRow(input),
      select: { id: true },
    });
    return row.id;
  }

  /**
   * Stores a search's priced results in one insert, each under the id its
   * result already names. Immutable from here on.
   */
  async saveCalculations(
    db: Prisma.TransactionClient,
    rows: CalculationRow[],
  ): Promise<void> {
    if (rows.length === 0) return;
    await db.priceCalculation.createMany({
      data: rows.map((row) => ({ id: row.id, ...calculationRow(row) })),
    });
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
      /** The booking's promotion code, kept on every quote (M10). */
      promotion?: PromotionInput | null;
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
      promotion: input.promotion ?? null,
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

  /**
   * A manual override's calculation (M10; pricing-engine.md, "Manual
   * override with reason"): the booking's calculation copied, never edited,
   * with an `OVERRIDE` line taking the total to the price set by hand, so
   * `total = sum(breakdown)` still holds. Flyviman absorbs the difference:
   * the operator's payable is unchanged and platform revenue moves by it;
   * tax is not worked out again. Priced as a `QUOTE`, with who set it and
   * why. Returns the new calculation's id.
   */
  async saveOverride(
    db: Prisma.TransactionClient,
    input: {
      fromCalculationId: string;
      totalMinor: number;
      validUntil: Date;
      overriddenById: string;
      reason: string;
      /** What the customer was last offered, for the record. */
      previous: { totalMinor: number; quoteReference: string | null };
      now: Date;
    },
  ): Promise<string> {
    const from = await db.priceCalculation.findUniqueOrThrow({
      where: { id: input.fromCalculationId },
    });
    const delta = BigInt(input.totalMinor) - from.totalMinor;
    const platformRevenueMinor = from.platformRevenueMinor + delta;
    const breakdown = [
      ...(Array.isArray(from.breakdown) ? from.breakdown : []),
      ...(delta === 0n
        ? []
        : [
            {
              code: 'OVERRIDE',
              label: 'Price set by Flyviman',
              amountMinor: Number(delta),
              basis: 'Manual override; the difference is Flyviman’s',
            },
          ]),
    ];
    const warnings = [
      ...(Array.isArray(from.warnings) ? from.warnings : []),
      ...(platformRevenueMinor < 0n
        ? ['Flyviman earns less than nothing on this trip after the override.']
        : []),
    ];
    const row = await db.priceCalculation.create({
      data: {
        searchId: from.searchId,
        aircraftId: from.aircraftId,
        operatorId: from.operatorId,
        inputs: {
          ...(from.inputs && typeof from.inputs === 'object'
            ? (from.inputs as Prisma.InputJsonObject)
            : {}),
          override: {
            fromCalculationId: from.id,
            previousTotalMinor: input.previous.totalMinor,
            previousQuoteReference: input.previous.quoteReference,
          },
        },
        appliedRules: from.appliedRules as Prisma.InputJsonValue,
        breakdown: breakdown as Prisma.InputJsonValue,
        baseMinor: from.baseMinor,
        feesMinor: from.feesMinor,
        taxMinor: from.taxMinor,
        discountMinor: from.discountMinor,
        totalMinor: BigInt(input.totalMinor),
        operatorPayableMinor: from.operatorPayableMinor,
        platformRevenueMinor,
        currency: from.currency,
        priceType: PriceType.QUOTE,
        validUntil: input.validUntil,
        availabilityCheckedAt: input.now,
        assumptions: [
          ...(Array.isArray(from.assumptions) ? from.assumptions : []),
          'Price set by hand by Flyviman; tax was not worked out again',
        ] as Prisma.InputJsonValue,
        exclusions: from.exclusions as Prisma.InputJsonValue,
        warnings: warnings as Prisma.InputJsonValue,
        overriddenById: input.overriddenById,
        overrideReason: input.reason,
      },
      select: { id: true },
    });
    return row.id;
  }

  async calculation(id: string) {
    return this.prisma.priceCalculation.findUnique({ where: { id } });
  }
}

/** A priced search result as stored. */
interface CalculationInput {
  searchId: string;
  aircraftId: string;
  operatorId: string;
  inputs: Prisma.InputJsonValue;
  result: EngineResult;
  availabilityCheckedAt: Date;
}

/** A priced search result with the id it is stored under. */
export interface CalculationRow extends CalculationInput {
  id: string;
}

/** The PriceCalculation columns of a priced search result. */
function calculationRow(
  input: CalculationInput,
): Prisma.PriceCalculationCreateManyInput {
  const { result } = input;
  return {
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
  };
}

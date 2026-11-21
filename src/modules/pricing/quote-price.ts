import {
  type AppliedRule,
  applyPromotion,
  type LineItem,
  percentOf,
  type PromotionInput,
} from './engine.js';
import type { PriceAssumption, PriceWarning } from './notes.js';
import type { ResolvedRules, RuleRow } from './rules.js';

/**
 * The customer's price for an operator's quote (D-172 B): the operator's
 * price is the operator subtotal, and Flyviman's commercial rules are added
 * exactly as the engine adds them to an estimate (pricing-engine.md, step 6):
 * commission, markup and service fee, then any discount and a promotion
 * code the booking carries (both funded by Flyviman and capped together at
 * its revenue, so the operator's payable never moves), then tax. Pure, so a quote is as traceable as an estimate.
 *
 * Kept apart from `calculatePrice` so engine work in parallel stays
 * untouched; `quote-price.spec.ts` checks parity with it for the same base.
 * The operator's price is taken as tax- and commission-exclusive, and the
 * minimum charge does not apply: the operator named its own price.
 */

export interface QuotePriceInput {
  /** Paise: the operator's price for the trip, before Flyviman's charges and tax. */
  operatorPriceMinor: number;
  /** Platform and category rules for the booking's aircraft. */
  rules: ResolvedRules;
  /**
   * The promotion code the booking was requested with, if any: a revised
   * quote keeps the customer's code (applied after the `DISCOUNT` rule,
   * before tax, as the engine does).
   */
  promotion?: PromotionInput | null;
}

export interface QuotePriceResult {
  breakdown: LineItem[];
  baseMinor: number;
  feesMinor: number;
  taxMinor: number;
  discountMinor: number;
  /** What the customer pays. */
  totalMinor: number;
  operatorPayableMinor: number;
  platformRevenueMinor: number;
  currency: 'INR';
  appliedRules: AppliedRule[];
  assumptions: PriceAssumption[];
  exclusions: string[];
  warnings: PriceWarning[];
}

export function priceOperatorQuote(input: QuotePriceInput): QuotePriceResult {
  const { rules } = input;
  const used: RuleRow[] = [];
  const use = <K extends keyof ResolvedRules>(key: K) => {
    const entry = rules[key];
    if (!entry) return undefined;
    used.push(entry.rule);
    return entry.config as NonNullable<ResolvedRules[K]>['config'];
  };
  const warnings: PriceWarning[] = [];
  const exclusions: string[] = [];
  const assumptions: PriceAssumption[] = [
    {
      code: 'OPERATOR_QUOTE',
      text: "The operator's quoted price, before Flyviman's charges and tax",
    },
  ];

  const baseMinor = input.operatorPriceMinor;
  const breakdown: LineItem[] = [
    {
      code: 'OPERATING',
      label: "Operator's price",
      amountMinor: baseMinor,
      basis: 'Quoted by the operator',
    },
  ];

  let feesMinor = 0;
  let commissionMinor = 0;
  const commission = use('COMMISSION');
  if (commission) {
    commissionMinor = percentOf(baseMinor, commission.percent);
    if (commission.mode === 'ADD_ON') {
      feesMinor = commissionMinor;
      breakdown.push({
        code: 'PLATFORM_FEE',
        label: 'Platform fee',
        amountMinor: feesMinor,
      });
    }
  } else {
    warnings.push({
      code: 'COMMISSION_MISSING',
      text: 'No commission rule is in force.',
    });
  }

  const markup = use('MARKUP');
  const markupMinor = markup ? percentOf(baseMinor, markup.percent) : 0;
  if (markupMinor > 0) {
    breakdown.push({
      code: 'MARKUP',
      label: 'Markup',
      amountMinor: markupMinor,
      basis: `${markup!.percent}% of the operator subtotal`,
    });
  }
  const serviceFeeMinor = use('SERVICE_FEE')?.amountMinor ?? 0;
  if (serviceFeeMinor > 0) {
    breakdown.push({
      code: 'SERVICE_FEE',
      label: 'Service fee',
      amountMinor: serviceFeeMinor,
      basis: 'Per trip',
    });
  }
  feesMinor += markupMinor + serviceFeeMinor;

  const discount = use('DISCOUNT');
  const platformMinor = commissionMinor + markupMinor + serviceFeeMinor;
  const offeredMinor = discount
    ? percentOf(baseMinor + feesMinor, discount.percent)
    : 0;
  const discountMinor = Math.min(offeredMinor, platformMinor);
  const capped = discountMinor > 0 && discountMinor < offeredMinor;
  if (capped) {
    assumptions.push({
      code: 'DISCOUNT_CAPPED',
      text: `${discount!.name} applied up to its limit for this trip`,
    });
  }
  if (discountMinor > 0) {
    breakdown.push({
      code: 'DISCOUNT',
      label: discount!.name,
      amountMinor: -discountMinor,
      basis: capped
        ? `${discount!.percent}% of the price before tax (${offeredMinor} offered), limited to Flyviman's charges on this trip`
        : `${discount!.percent}% of the price before tax`,
    });
  }

  // The booking's promotion code on top, limited to what Flyviman still
  // earns after the discount, as in the engine.
  const promotion = applyPromotion(
    input.promotion ?? null,
    baseMinor + feesMinor - discountMinor,
    platformMinor - discountMinor,
  );
  if (promotion) {
    if (promotion.capped) {
      assumptions.push({
        code: 'PROMOTION_CAPPED',
        text: `${promotion.name} applied up to its limit for this trip`,
      });
    }
    if (promotion.amountMinor > 0) {
      breakdown.push({
        code: 'PROMOTION',
        label: promotion.name,
        amountMinor: -promotion.amountMinor,
        basis: promotion.basis,
      });
    }
  }
  const discountsMinor = discountMinor + (promotion?.amountMinor ?? 0);

  let taxMinor = 0;
  const tax = use('TAX');
  if (tax) {
    taxMinor = percentOf(baseMinor + feesMinor - discountsMinor, tax.percent);
    breakdown.push({ code: 'TAX', label: tax.name, amountMinor: taxMinor });
  } else {
    warnings.push({
      code: 'TAX_MISSING',
      text: 'No tax rule is in force; tax is not included.',
    });
    exclusions.push('Taxes');
  }

  const seen = new Map<string, AppliedRule>();
  for (const rule of used) {
    seen.set(rule.id, {
      id: rule.id,
      type: rule.type,
      scope: rule.scope,
      version: rule.version,
    });
  }
  return {
    breakdown,
    baseMinor,
    feesMinor,
    taxMinor,
    discountMinor: discountsMinor,
    totalMinor: baseMinor + feesMinor - discountsMinor + taxMinor,
    operatorPayableMinor:
      commission?.mode === 'DEDUCTED' ? baseMinor - commissionMinor : baseMinor,
    platformRevenueMinor: platformMinor - discountsMinor,
    currency: 'INR',
    appliedRules: promotion
      ? [
          ...seen.values(),
          // Not a pricing rule: the promotion's own row, never edited.
          {
            id: promotion.id,
            type: 'PROMOTION',
            scope: 'PROMOTION',
            version: 1,
          },
        ]
      : [...seen.values()],
    assumptions,
    exclusions,
    warnings,
  };
}

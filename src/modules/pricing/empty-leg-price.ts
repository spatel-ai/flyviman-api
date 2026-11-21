import type { AppliedRule, LineItem } from './engine.js';
import type { ResolvedRules, RuleRow } from './rules.js';

/**
 * The parts of an empty-leg offer's price (M8-C). The offer's price is the
 * customer's tax-inclusive total (lead decision, open-decisions.md), so the
 * rules are applied backwards: the tax in force is taken out first, then
 * Flyviman's commission, leaving the operator's payable. Markup, service
 * fee and discounts do not apply: the operator named the whole price.
 * Pure. The parts always add up to the total (`settlement-rules.ts`).
 *
 * Commission `DEDUCTED`: the pre-tax price is the operator's subtotal and
 * the commission comes out of it. `ADD_ON`: the pre-tax price is the
 * operator's subtotal plus a platform fee of the commission's percent of it.
 */

export interface EmptyLegPriceResult {
  breakdown: LineItem[];
  baseMinor: number;
  feesMinor: number;
  taxMinor: number;
  discountMinor: 0;
  totalMinor: number;
  operatorPayableMinor: number;
  platformRevenueMinor: number;
  currency: 'INR';
  appliedRules: AppliedRule[];
  assumptions: string[];
  exclusions: string[];
  warnings: string[];
}

/** `amount / (1 + percent / 100)`, half up, in whole paise. */
function withoutPercent(amountMinor: number, percent: number): number {
  const divisor = 10_000n + BigInt(Math.round(percent * 100));
  const scaled = BigInt(amountMinor) * 10_000n;
  return Number((scaled * 2n + divisor) / (2n * divisor));
}

/** `amount × percent / 100`, half up, in whole paise (as the engine). */
function percentOf(amountMinor: number, percent: number): number {
  const product = BigInt(amountMinor) * BigInt(Math.round(percent * 100));
  return Number((product * 2n + 10_000n) / 20_000n);
}

export function priceEmptyLegTotal(input: {
  /** Paise: the offer's price, what the customer pays, tax included. */
  totalMinor: number;
  rules: ResolvedRules;
}): EmptyLegPriceResult {
  const { rules, totalMinor } = input;
  const used: RuleRow[] = [];
  const warnings: string[] = [];
  const exclusions: string[] = [];

  const tax = rules.TAX;
  let preTaxMinor = totalMinor;
  if (tax) {
    used.push(tax.rule);
    preTaxMinor = withoutPercent(totalMinor, tax.config.percent);
  } else {
    warnings.push('No tax rule is in force; no tax is taken out.');
    exclusions.push('Taxes');
  }
  const taxMinor = totalMinor - preTaxMinor;

  const commission = rules.COMMISSION;
  let baseMinor = preTaxMinor;
  let feesMinor = 0;
  let operatorPayableMinor = preTaxMinor;
  if (commission) {
    used.push(commission.rule);
    if (commission.config.mode === 'ADD_ON') {
      baseMinor = withoutPercent(preTaxMinor, commission.config.percent);
      feesMinor = preTaxMinor - baseMinor;
      operatorPayableMinor = baseMinor;
    } else {
      operatorPayableMinor =
        preTaxMinor - percentOf(preTaxMinor, commission.config.percent);
    }
  } else {
    warnings.push('No commission rule is in force.');
  }

  const breakdown: LineItem[] = [
    {
      code: 'OPERATING',
      label: "Operator's price",
      amountMinor: baseMinor,
      basis: 'The empty-leg offer, before tax',
    },
  ];
  if (feesMinor > 0) {
    breakdown.push({
      code: 'PLATFORM_FEE',
      label: 'Platform fee',
      amountMinor: feesMinor,
    });
  }
  if (tax) {
    breakdown.push({
      code: 'TAX',
      label: tax.config.name,
      amountMinor: taxMinor,
    });
  }

  return {
    breakdown,
    baseMinor,
    feesMinor,
    taxMinor,
    discountMinor: 0,
    totalMinor,
    operatorPayableMinor,
    platformRevenueMinor: preTaxMinor - operatorPayableMinor,
    currency: 'INR',
    appliedRules: used.map((rule) => ({
      id: rule.id,
      type: rule.type,
      scope: rule.scope,
      version: rule.version,
    })),
    assumptions: [
      "The operator's empty-leg price is the customer's total, tax included",
    ],
    exclusions,
    warnings,
  };
}

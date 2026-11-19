import type {
  AircraftCategory,
  PricingRuleScope,
  PricingRuleType,
} from '../../generated/prisma/enums.js';

/** A stored rule as the engine sees it. */
export interface RuleRow {
  id: string;
  scope: PricingRuleScope;
  scopeRef: string | null;
  type: PricingRuleType;
  config: unknown;
  priority: number;
  version: number;
}

/** An operator's rate, and whether it already includes tax or commission. */
export interface OperatorRate {
  amountMinor: number;
  currency: string;
  taxInclusive?: boolean;
  commissionInclusive?: boolean;
}

/** One route an aircraft flies at a fixed price, in either direction. */
export interface FixedRoute {
  originId: string;
  destinationId: string;
  amountMinor: number;
}

/** Config shapes of the rule types the engine applies today. */
export interface RuleConfigs {
  HOURLY_RATE: OperatorRate;
  /** Per flight (sector), for an aircraft priced by sector. */
  SECTOR_RATE: OperatorRate;
  /** Fixed prices per route, for an aircraft priced by fixed route. */
  FIXED_ROUTE: Omit<OperatorRate, 'amountMinor'> & { routes: FixedRoute[] };
  /** `per` absent is `LEG`: the minimum applies to each flight. */
  MIN_BILLABLE_HOURS: { hours: number; per?: 'LEG' | 'DAY' };
  POSITIONING: { rateFactor: number; freeWithinKm?: number };
  /** Per hour on the ground between a round trip's flights, beyond `freeHours`. */
  WAITING: { amountMinor: number; freeHours: number };
  /** Per night the aircraft spends away from base. */
  OVERNIGHT: { amountMinor: number };
  /** Crew allowance and accommodation per night away from base. */
  CREW: { amountMinor: number };
  LANDING: { amountMinor: number };
  HANDLING: { amountMinor: number };
  /** Per customer flight, tax- and commission-exclusive like landing. */
  FUEL_SURCHARGE: { amountMinor: number };
  PERMIT: { amountMinor: number };
  NAVIGATION: { amountMinor: number };
  /** Once per trip, under the operator's own label. */
  OTHER: { label: string; amountMinor: number };
  /** Platform: a share of the operator subtotal, added for Flyviman. */
  MARKUP: { percent: number };
  /** Platform: a flat fee per trip. */
  SERVICE_FEE: { amountMinor: number };
  /** Platform: a share of the price before tax, funded by Flyviman. */
  DISCOUNT: { name: string; percent: number };
  MIN_CHARGE: { amountMinor: number };
  COMMISSION: { percent: number; mode: 'ADD_ON' | 'DEDUCTED' };
  TAX: { name: string; percent: number };
  ROUTING_FACTOR: { factor: number };
  /**
   * `minutes` per leg for taxi and procedures; `turnaroundMinutes`, the
   * ground time needed at each end of a return to base between a round
   * trip's flights (left out: the engine's default).
   */
  TIME_ALLOWANCE: { minutes: number; turnaroundMinutes?: number };
  VALIDITY: { minutes: number };
}

export type AppliedType = keyof RuleConfigs;

export type ResolvedRules = {
  [K in AppliedType]?: { rule: RuleRow; config: RuleConfigs[K] };
};

/** Only Flyviman sets these; operator and aircraft rules of these types are ignored. */
const PLATFORM_OWNED = new Set<string>([
  'COMMISSION',
  'MARKUP',
  'SERVICE_FEE',
  'TAX',
  'DISCOUNT',
]);

/** Most specific wins (pricing-engine.md, rule model). Routes come later. */
const RANK: Record<PricingRuleScope, number> = {
  ROUTE: 5,
  AIRCRAFT: 4,
  OPERATOR: 3,
  CATEGORY: 2,
  PLATFORM: 1,
};

export interface RuleTarget {
  aircraftId: string;
  operatorId: string;
  category: AircraftCategory;
}

/** Whether a rule speaks about this aircraft at all. */
export function appliesTo(rule: RuleRow, target: RuleTarget): boolean {
  switch (rule.scope) {
    case 'PLATFORM':
      return true;
    case 'CATEGORY':
      return rule.scopeRef === target.category;
    case 'OPERATOR':
      return rule.scopeRef === target.operatorId;
    case 'AIRCRAFT':
      return rule.scopeRef === target.aircraftId;
    default:
      return false;
  }
}

/**
 * One rule per type for this aircraft: the most specific scope, then the
 * highest priority, then the latest version. `rules` must already be the
 * active ones (in force now).
 */
export function resolveRules(
  rules: RuleRow[],
  target: RuleTarget,
): ResolvedRules {
  const best = new Map<string, RuleRow>();
  for (const rule of rules) {
    if (!appliesTo(rule, target)) continue;
    if (
      PLATFORM_OWNED.has(rule.type) &&
      rule.scope !== 'PLATFORM' &&
      rule.scope !== 'CATEGORY'
    ) {
      continue;
    }
    const current = best.get(rule.type);
    if (!current || outranks(rule, current)) best.set(rule.type, rule);
  }
  const resolved: Record<string, { rule: RuleRow; config: unknown }> = {};
  for (const [type, rule] of best)
    resolved[type] = { rule, config: rule.config };
  return resolved as ResolvedRules;
}

function outranks(a: RuleRow, b: RuleRow): boolean {
  if (RANK[a.scope] !== RANK[b.scope]) return RANK[a.scope] > RANK[b.scope];
  if (a.priority !== b.priority) return a.priority > b.priority;
  return a.version > b.version;
}

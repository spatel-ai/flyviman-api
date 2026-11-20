import type { LineCode } from '../pricing/engine.js';

/**
 * Every flight line: the customer's legs (hourly, sector or fixed-route),
 * the per-day minimum billable hours, positioning and ferries. Every engine
 * line code is in exactly one of this set and `SHOWN_LINES`
 * (`breakdown.spec.ts`).
 */
export const FLIGHT_LINES: ReadonlySet<string> = new Set<LineCode>([
  'OPERATING',
  'OPERATING_RETURN',
  'MIN_BILLABLE',
  // Flyviman's markup is not shown on its own (lead, W2-4 review).
  'MARKUP',
  'POSITIONING',
  'REPOSITIONING',
  'INTERIM_REPOSITIONING',
  'INTERIM_POSITIONING',
]);

/**
 * Lines a customer sees as they are. Their labels name no base: waiting,
 * overnight and parking name the customer's own destination, and `OTHER`
 * carries the operator's own label.
 */
export const SHOWN_LINES: ReadonlySet<string> = new Set<LineCode>([
  'WAITING',
  'OVERNIGHT',
  'CREW',
  'PARKING',
  'FUEL_SURCHARGE',
  'PERMIT',
  'NAVIGATION',
  'OTHER',
  'LANDING_HANDLING',
  'MIN_CHARGE',
  'PLATFORM_FEE',
  'SERVICE_FEE',
  'DISCOUNT',
  // The promotion's name, chosen by finance; an override's line is never
  // on a customer's price (it is on the overriding quote's calculation).
  'PROMOTION',
  'OVERRIDE',
  'TAX',
]);

/**
 * The breakdown a customer sees (D-099). Flight lines, and the markup, are
 * combined into one "Flying" line, so per-leg amounts (hours × rate) and the aircraft's base
 * in positioning labels are not shown; other lines pass through. An
 * explicit allowlist of fields: the `basis` wording, and anything added to
 * a stored line later, never reaches customers. The stored calculation and
 * the admin viewer keep every line. Read at answer time, so searches stored
 * earlier are combined too.
 */
export function customerBreakdown(
  lines: { code: string; label: string; amountMinor: number }[],
): { code: string; label: string; amountMinor: number }[] {
  const result: { code: string; label: string; amountMinor: number }[] = [];
  let flying: { code: string; label: string; amountMinor: number } | null =
    null;
  for (const { code, label, amountMinor } of lines) {
    if (!FLIGHT_LINES.has(code)) {
      result.push({ code, label, amountMinor });
    } else if (flying) {
      flying.amountMinor += amountMinor;
    } else {
      flying = { code: 'FLYING', label: 'Flying', amountMinor };
      result.push(flying);
    }
  }
  return result;
}

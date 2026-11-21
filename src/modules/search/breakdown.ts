import type { LineCode } from '../pricing/engine.js';
import {
  ASSUMPTION_CODES,
  type AssumptionCode,
  codedEntries,
} from '../pricing/notes.js';

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
  // The promotion's name, chosen by finance.
  'PROMOTION',
  // A price set by hand (D-179) is a new quote whose calculation is the old
  // one plus this line, so no search result carries it. Shown as "Price set
  // by Flyviman" wherever a customer sees that quote's lines, because
  // folding it into another line would misstate that line and dropping it
  // would break sum(lines) = total.
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

/** Shown as stored: the wording names nothing a customer may not see. */
const AS_STORED = Symbol('as stored');

/**
 * What a customer reads for each assumption code (D-099): the stored text
 * when it names nothing restricted, else a general sentence, or nothing.
 * Stored texts can name the aircraft's base and say why one round-trip
 * option was priced below the other; customers never see either. A Record,
 * so a new code does not compile until it is classified here.
 */
export const CUSTOMER_ASSUMPTIONS: Record<
  AssumptionCode,
  string | typeof AS_STORED | null
> = {
  // The routing factor only.
  ROUTING: AS_STORED,
  REPOSITIONING: "Includes the aircraft's positioning flights",
  // The base is the destination here: not said.
  ROUND_TRIP_AT_BASE:
    'Round trip: the aircraft stays at your destination between the flights',
  ROUND_TRIP_WAIT:
    'Round trip: the aircraft waits at your destination until the return flight',
  ROUND_TRIP_RETURN_TO_BASE:
    "Round trip: the aircraft returns to its base between the flights; includes the aircraft's positioning flights",
  // The discount's or code's name, already on its line, and that a limit
  // applied; the limit itself stays in the stored basis.
  DISCOUNT_CAPPED: AS_STORED,
  PROMOTION_CAPPED: AS_STORED,
  OPERATOR_QUOTE: "Priced from the operator's quote",
  EMPTY_LEG_PRICE: 'The empty-leg price includes tax',
  // Internal: how the hand-set price was recorded.
  PRICE_OVERRIDE: null,
};

/**
 * The assumptions a customer sees, from a stored calculation's (or the
 * engine's) coded entries, each sentence once. Entries without a code,
 * stored before codes existed, are left out. Read at answer time, so
 * calculations stored earlier are mapped too.
 */
export function customerAssumptions(stored: unknown): string[] {
  const shown = codedEntries(stored, ASSUMPTION_CODES).flatMap((entry) => {
    const wording = CUSTOMER_ASSUMPTIONS[entry.code];
    if (wording === null) return [];
    return [wording === AS_STORED ? entry.text : wording];
  });
  return [...new Set(shown)];
}

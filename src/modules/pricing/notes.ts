/**
 * The assumptions and warnings a stored `PriceCalculation` carries, each
 * with a code so every audience is served by an allowlist of codes, never
 * by reading the wording. The text is the full internal wording (it may
 * name the aircraft's base and why one option was chosen): finance and the
 * calculation viewer read it. Customers get the wording `customerAssumptions`
 * (search/breakdown.ts) maps each code to; operations get the warnings
 * `WARNING_AUDIENCE` allows them.
 */

export const ASSUMPTION_CODES = [
  /** Great-circle distance with the routing factor. */
  'ROUTING',
  /** The aircraft flies back to its base after the trip. */
  'REPOSITIONING',
  /** Round trip ending where the aircraft is based: it stays there. */
  'ROUND_TRIP_AT_BASE',
  /** Round trip: the aircraft waits at the destination. */
  'ROUND_TRIP_WAIT',
  /** Round trip: the aircraft flies to its base and back between flights. */
  'ROUND_TRIP_RETURN_TO_BASE',
  /** The discount rule was limited to Flyviman's charges. */
  'DISCOUNT_CAPPED',
  /** The promotion code was limited to Flyviman's charges. */
  'PROMOTION_CAPPED',
  /** An operator's quote: the operator's price before Flyviman's charges. */
  'OPERATOR_QUOTE',
  /** An empty leg: the offer's price is the customer's total. */
  'EMPTY_LEG_PRICE',
  /** A price set by hand (D-179). */
  'PRICE_OVERRIDE',
] as const;
export type AssumptionCode = (typeof ASSUMPTION_CODES)[number];

export const WARNING_CODES = [
  /** Why a result could not be priced. */
  'NOT_PRICED',
  /** An operator rate or charge rule is not set. */
  'RATE_MISSING',
  /** A location's landing, handling or parking charge is not on record. */
  'CHARGE_NOT_ON_RECORD',
  'TAX_MISSING',
  'COMMISSION_MISSING',
  /** An operator rate is marked tax-inclusive with no tax in force. */
  'TAX_INCLUSIVE_IGNORED',
  /** An operator rate is marked commission-inclusive, but not ADD_ON. */
  'COMMISSION_INCLUSIVE_IGNORED',
  /** Platform revenue below zero after a manual override. */
  'REVENUE_NEGATIVE',
] as const;
export type WarningCode = (typeof WARNING_CODES)[number];

export interface PriceAssumption {
  code: AssumptionCode;
  text: string;
}

export interface PriceWarning {
  code: WarningCode;
  text: string;
}

/**
 * Who sees a warning in the calculation viewer. Commission and platform
 * revenue are finance matters: operations do not see platform revenue or
 * its sign (D-103), so their warnings are for finance and super admins.
 */
export const WARNING_AUDIENCE: Record<WarningCode, 'STAFF' | 'FINANCE'> = {
  NOT_PRICED: 'STAFF',
  RATE_MISSING: 'STAFF',
  CHARGE_NOT_ON_RECORD: 'STAFF',
  TAX_MISSING: 'STAFF',
  TAX_INCLUSIVE_IGNORED: 'STAFF',
  COMMISSION_MISSING: 'FINANCE',
  COMMISSION_INCLUSIVE_IGNORED: 'FINANCE',
  REVENUE_NEGATIVE: 'FINANCE',
};

function list(stored: unknown): unknown[] {
  return Array.isArray(stored) ? stored : [];
}

/**
 * The coded entries of a stored list. Plain strings, written before codes
 * existed, cannot be classified and are left out (fail closed).
 */
export function codedEntries<C extends string>(
  stored: unknown,
  codes: readonly C[],
): { code: C; text: string }[] {
  return list(stored).filter(
    (entry): entry is { code: C; text: string } =>
      typeof entry === 'object' &&
      entry !== null &&
      codes.includes((entry as { code: C }).code) &&
      typeof (entry as { text: unknown }).text === 'string',
  );
}

/** Every entry's full text, older plain strings included: finance's view. */
export function entryTexts(stored: unknown): string[] {
  return list(stored).flatMap((entry) =>
    typeof entry === 'string'
      ? [entry]
      : typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as { text: unknown }).text === 'string'
        ? [(entry as { text: string }).text]
        : [],
  );
}

/**
 * The warnings a member of staff sees: all of them for finance and super
 * admins; for operations only the coded ones `WARNING_AUDIENCE` gives staff.
 */
export function visibleWarnings(stored: unknown, finance: boolean): string[] {
  if (finance) return entryTexts(stored);
  return codedEntries(stored, WARNING_CODES)
    .filter((warning) => WARNING_AUDIENCE[warning.code] === 'STAFF')
    .map((warning) => warning.text);
}

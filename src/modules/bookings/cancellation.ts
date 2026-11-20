import { PriceType } from '../../generated/prisma/enums.js';
import type { CancellationCharge, CancellationTerms } from './booking-json.js';

/**
 * What cancelling a booking now would cost, worked out from the terms the
 * customer was shown (rule 9). Pure, so it is unit tested; the quote route
 * and the cancel route both call it, the cancel route inside its
 * transaction.
 *
 * The operator's terms apply from the moment the request is sent (owner,
 * 2026-11-20). A charge is a percentage of the price, so it is money only
 * once the price is `CONFIRMED`: before that the rule that would apply is
 * shown and the charge is 0, and `amountKnown` says so. No amount is ever
 * invented.
 */

export interface CancellationInput {
  terms: CancellationTerms;
  /** The first departure, ISO 8601 UTC. */
  departureAt: string;
  now: Date;
  totalMinor: bigint;
  priceType: PriceType;
  /** Paid towards the booking (`paid-amount.ts`). */
  paidMinor: bigint;
}

export interface CancellationOutcome {
  /** Whole hours from now to the first departure; 0 once it has passed. */
  hoursBeforeDeparture: number;
  /** The rule that applies now, or null when the terms have none. */
  appliedCharge: CancellationCharge | null;
  /** The charge is money only when the price is confirmed. */
  amountKnown: boolean;
  chargeMinor: bigint;
  /** What the customer has paid towards the booking. */
  paidMinor: bigint;
  /** Paid less the charge, never below 0. */
  refundMinor: bigint;
}

const HOUR_MS = 3_600_000;

/**
 * The charge rule for this much notice: the first rule (longest notice
 * first) whose notice is met. Notice shorter than every rule gets the last,
 * shortest-notice rule, which is the strictest the operator wrote down;
 * nothing stricter is assumed.
 */
export function chargeFor(
  charges: readonly CancellationCharge[],
  hoursBeforeDeparture: number,
): CancellationCharge | null {
  if (charges.length === 0) return null;
  return (
    charges.find(
      (charge) => hoursBeforeDeparture >= charge.minHoursBeforeDeparture,
    ) ?? charges[charges.length - 1]
  );
}

export function evaluateCancellation(
  input: CancellationInput,
): CancellationOutcome {
  const untilDeparture = Date.parse(input.departureAt) - input.now.getTime();
  const hoursBeforeDeparture = Math.max(
    0,
    Math.floor(untilDeparture / HOUR_MS),
  );
  const appliedCharge = chargeFor(input.terms.charges, hoursBeforeDeparture);
  const amountKnown = input.priceType === PriceType.CONFIRMED;
  // Rounded down to the paisa, in the customer's favour.
  const chargeMinor =
    amountKnown && appliedCharge
      ? (input.totalMinor * BigInt(appliedCharge.chargePercent)) / 100n
      : 0n;
  const { paidMinor } = input;
  const refundMinor = paidMinor > chargeMinor ? paidMinor - chargeMinor : 0n;
  return {
    hoursBeforeDeparture,
    appliedCharge,
    amountKnown,
    chargeMinor,
    paidMinor,
    refundMinor,
  };
}

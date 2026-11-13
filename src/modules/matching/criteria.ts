/**
 * The matching checks that need no database (pricing-engine.md, step 3).
 * Each failed check is returned as a reason code, so operations can see why
 * an aircraft was left out.
 */

/** Range must cover the leg with this margin to spare. */
export const RANGE_RESERVE = 1.1;

/**
 * `listingNotApproved`, `operatorNotApproved`, `notAvailable`, the
 * `missing()` codes (`rangeKm`, `document:<TYPE>`), `location`, `capacity`,
 * `range`, `positioning`, `availability`.
 */
export type ExclusionReason = string;

export function staticChecks(input: {
  passengerCapacity: number;
  passengerCount: number;
  rangeKm: number | null;
  distanceKm: number;
  /** Minutes to fly from where the aircraft is to the origin. */
  positioningMinutes: number;
  departureAt: Date;
  now: Date;
}): ExclusionReason[] {
  const reasons: ExclusionReason[] = [];
  if (input.passengerCapacity < input.passengerCount) reasons.push('capacity');
  if (
    input.rangeKm == null ||
    input.rangeKm < input.distanceKm * RANGE_RESERVE
  ) {
    reasons.push('range');
  }
  const ready = input.now.getTime() + input.positioningMinutes * 60_000;
  if (ready > input.departureAt.getTime()) reasons.push('positioning');
  return reasons;
}

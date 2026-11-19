/**
 * A `BigInt` money column (paise) as the plain JSON integer the API returns
 * (`api-design.md`, Money). Amounts are bounded far below 2^53 by the rule
 * and input ceilings, so this never rounds; if one ever could, it fails
 * loudly instead of returning a wrong price.
 */
export function minorToNumber(value: bigint): number {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount)) {
    throw new RangeError('Money amount is outside the safe integer range.');
  }
  return amount;
}

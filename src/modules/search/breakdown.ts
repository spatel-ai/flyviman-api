/** Every flight line: the customer's legs, positioning and ferries. */
const FLIGHT_LINES = new Set([
  'OPERATING',
  'OPERATING_RETURN',
  'POSITIONING',
  'REPOSITIONING',
  'INTERIM_REPOSITIONING',
  'INTERIM_POSITIONING',
]);

/**
 * The breakdown a customer sees (D-099). Flight lines are combined into one
 * "Flying" line, so per-leg amounts (hours × rate) and the aircraft's base
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

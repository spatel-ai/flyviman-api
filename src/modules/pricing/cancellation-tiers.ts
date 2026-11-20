/**
 * Flyviman's cancellation tier table (D-172): one table for every operator,
 * stored as the platform `CANCELLATION_TIERS` pricing rule so it is
 * versioned, locked and audited like the commercial rules. Pure, so the API
 * and its tests share one definition.
 *
 * A tier applies when the notice left is at least its
 * `minHoursBeforeDeparture` (`bookings/cancellation.ts`, `chargeFor`), so a
 * boundary falls in the cheaper tier, in the customer's favour (D-167). The
 * summary says so in words, because the text shown must be the rule applied
 * (rule 9).
 */

export interface CancellationTier {
  /** Applies when cancelling at least this many hours before departure. */
  minHoursBeforeDeparture: number;
  /** Of the confirmed price, a whole percent from 0 to 100. */
  chargePercent: number;
}

export interface TiersConfig {
  tiers: CancellationTier[];
}

export const MAX_TIERS = 10;
/** A year's notice is the longest tier anyone needs. */
export const MAX_NOTICE_HOURS = 8760;

export type TiersCheck =
  | { ok: true; config: TiersConfig }
  | { ok: false; errors: { field: string; message: string }[] };

const TIER_KEYS = ['minHoursBeforeDeparture', 'chargePercent'];

function wholeIn(value: unknown, min: number, max: number): boolean {
  return (
    Number.isInteger(value) &&
    (value as number) >= min &&
    (value as number) <= max
  );
}

/**
 * Checks a tier table: 1 to 10 tiers, the longest notice first with each
 * notice once, ending with a tier at 0 hours (so a late cancellation or a
 * no-show always has a rule), and a charge that never falls as the notice
 * shortens. Unknown keys are refused.
 */
export function checkTiers(value: unknown): TiersCheck {
  const errors: { field: string; message: string }[] = [];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {
      ok: false,
      errors: [{ field: 'config', message: 'must be an object.' }],
    };
  }
  for (const key of Object.keys(value)) {
    if (key !== 'tiers')
      errors.push({
        field: `config.${key}`,
        message: `${key} is not a setting.`,
      });
  }
  const raw = (value as Record<string, unknown>).tiers;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_TIERS) {
    errors.push({
      field: 'tiers',
      message: `must list 1 to ${MAX_TIERS} tiers.`,
    });
    return { ok: false, errors };
  }
  const tiers: CancellationTier[] = [];
  raw.forEach((entry: unknown, index) => {
    const field = `tiers.${index}`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push({ field, message: 'must be an object.' });
      return;
    }
    const tier = entry as Record<string, unknown>;
    for (const key of Object.keys(tier)) {
      if (!TIER_KEYS.includes(key))
        errors.push({
          field: `${field}.${key}`,
          message: `${key} is not a setting.`,
        });
    }
    if (!wholeIn(tier.minHoursBeforeDeparture, 0, MAX_NOTICE_HOURS)) {
      errors.push({
        field: `${field}.minHoursBeforeDeparture`,
        message: `must be a whole number of hours from 0 to ${MAX_NOTICE_HOURS}.`,
      });
    }
    if (!wholeIn(tier.chargePercent, 0, 100)) {
      errors.push({
        field: `${field}.chargePercent`,
        message: 'must be a whole percent from 0 to 100.',
      });
    }
    tiers.push({
      minHoursBeforeDeparture: tier.minHoursBeforeDeparture as number,
      chargePercent: tier.chargePercent as number,
    });
  });
  if (errors.length > 0) return { ok: false, errors };
  for (let i = 1; i < tiers.length; i += 1) {
    if (
      tiers[i].minHoursBeforeDeparture >= tiers[i - 1].minHoursBeforeDeparture
    ) {
      errors.push({
        field: `tiers.${i}.minHoursBeforeDeparture`,
        message:
          'must be shorter than the tier above: longest notice first, each notice once.',
      });
    } else if (tiers[i].chargePercent < tiers[i - 1].chargePercent) {
      errors.push({
        field: `tiers.${i}.chargePercent`,
        message: 'must be at least the charge for longer notice.',
      });
    }
  }
  if (tiers[tiers.length - 1].minHoursBeforeDeparture !== 0) {
    errors.push({
      field: `tiers.${tiers.length - 1}.minHoursBeforeDeparture`,
      message:
        'the last tier must start at 0 hours, for late cancellations and no-shows.',
    });
  }
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, config: { tiers } };
}

function hours(n: number): string {
  return n === 1 ? '1 hour' : `${n} hours`;
}

/** One line per tier, in the wording the evaluator applies. */
export function tierLines(tiers: readonly CancellationTier[]): string[] {
  return tiers.map((tier, index) => {
    const charge = `${tier.chargePercent}% of the price`;
    const longer = index > 0 ? tiers[index - 1].minHoursBeforeDeparture : null;
    if (tier.minHoursBeforeDeparture === 0) {
      return longer === null
        ? `Any time before departure, or a no-show: ${charge}`
        : `Under ${hours(longer)} before departure, or a no-show: ${charge}`;
    }
    return longer === null
      ? `${hours(tier.minHoursBeforeDeparture)} or more before departure: ${charge}`
      : `${hours(tier.minHoursBeforeDeparture)} to under ${hours(longer)} before departure: ${charge}`;
  });
}

/**
 * The terms in words, shown with every result and snapshotted on a booking
 * request word for word (rule 9).
 */
export function tiersSummary(tiers: readonly CancellationTier[]): string {
  return `Flyviman's cancellation terms, the same for every operator. ${tierLines(tiers).join('. ')}. A charge is taken only from a confirmed price.`;
}

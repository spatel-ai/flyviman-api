/**
 * Turns a report's response object into CSV (W5-1). The CSV is built from
 * the same object the JSON route returns, so it carries exactly the fields
 * the caller may see (no finance block for operations).
 *
 * One row per figure, in long form: `section, dimension, metric, currency,
 * value`. `dimension` names the row of a breakdown (its category, status,
 * operator and so on, joined with " / ").
 */

type Cell = string | number | boolean | null;

const HEADER = ['section', 'dimension', 'metric', 'currency', 'value'];

/** Fields that name a breakdown row rather than hold a figure. */
const DIMENSIONS = new Set([
  'category',
  'status',
  'operatorId',
  'operatorName',
  'method',
  'reason',
]);

function isMoney(value: unknown): value is {
  currency: string;
  amountMinor: number;
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 2 &&
    'currency' in value &&
    'amountMinor' in value
  );
}

function join(prefix: string, key: string): string {
  return prefix ? `${prefix}.${key}` : key;
}

export function reportRows(report: object): Cell[][] {
  const rows: Cell[][] = [];

  const walk = (
    value: unknown,
    section: string,
    dimensions: string[],
    metric: string,
    currency: string | null,
  ): void => {
    if (value === undefined) return;
    if (isMoney(value)) {
      rows.push([
        section,
        dimensions.join(' / '),
        metric,
        value.currency,
        value.amountMinor,
      ]);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item !== 'object' || item === null || isMoney(item)) {
          walk(item, section, dimensions, metric, currency);
          continue;
        }
        const entries = Object.entries(item as Record<string, unknown>);
        const own = entries
          .filter(([key]) => DIMENSIONS.has(key))
          .map(([, v]) => (typeof v === 'string' ? v : '(none)'));
        const itemCurrency =
          typeof (item as { currency?: unknown }).currency === 'string'
            ? (item as { currency: string }).currency
            : currency;
        for (const [key, v] of entries) {
          if (DIMENSIONS.has(key) || key === 'currency') continue;
          walk(
            v,
            section,
            [...dimensions, ...own],
            join(metric, key),
            itemCurrency,
          );
        }
      }
      return;
    }
    if (typeof value === 'object' && value !== null) {
      for (const [key, v] of Object.entries(value)) {
        walk(v, section, dimensions, join(metric, key), currency);
      }
      return;
    }
    rows.push([
      section,
      dimensions.join(' / '),
      metric,
      currency,
      value as Cell,
    ]);
  };

  for (const [key, value] of Object.entries(report)) {
    if (typeof value === 'object' && value !== null && !isMoney(value)) {
      walk(value, key, [], '', null);
    } else {
      walk(value, 'summary', [], key, null);
    }
  }
  return rows;
}

/**
 * One CSV cell. A string that a spreadsheet would run as a formula (it
 * starts with `=`, `+`, `-`, `@`, a tab or a carriage return) is prefixed
 * with `'`; numbers stay numbers, so a negative amount is not text.
 */
export function csvCell(value: Cell): string {
  if (value === null) return '';
  if (typeof value !== 'string') return String(value);
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function toCsv(report: object): string {
  return [HEADER, ...reportRows(report)]
    .map((row) => row.map(csvCell).join(','))
    .join('\r\n')
    .concat('\r\n');
}

import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception.js';
import { indiaToday } from '../../common/india-date.js';

const DAY_MS = 86_400_000;
/** India has one offset and no daylight saving (open decision 12). */
const IST_OFFSET = '+05:30';
/** The default period: the last 30 days in India, today included. */
export const DEFAULT_DAYS = 30;
/** The longest period a report covers. */
export const MAX_DAYS = 366;

/** A report's period as calendar days in India, and the instants it spans. */
export interface ReportPeriod {
  /** First day, `YYYY-MM-DD`, India. */
  from: string;
  /** Last day, included, `YYYY-MM-DD`, India. */
  to: string;
  /** Prisma filter: from the start of `from` in India to the start of the day after `to`. */
  range: { gte: Date; lt: Date };
}

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function invalid(field: string, issue: string): never {
  throw new AppException(
    'VALIDATION_ERROR',
    'The request is not valid.',
    HttpStatus.BAD_REQUEST,
    [{ field, issue }],
  );
}

/**
 * Resolves `from` and `to` (calendar days, India, both included) with IST
 * day boundaries (D-186). `to` defaults to today in India and `from` to 29
 * days before `to`. Refuses `from` after `to` and a span over 366 days.
 */
export function resolvePeriod(
  query: { from?: string; to?: string },
  now = new Date(),
): ReportPeriod {
  const to = query.to ?? indiaToday(now);
  const from = query.from ?? addDays(to, -(DEFAULT_DAYS - 1));
  if (from > to) invalid('from', 'must not be after to');
  const days = (Date.parse(to) - Date.parse(from)) / DAY_MS + 1;
  if (days > MAX_DAYS)
    invalid('from', `the period is at most ${MAX_DAYS} days`);
  return {
    from,
    to,
    range: {
      gte: new Date(`${from}T00:00:00${IST_OFFSET}`),
      lt: new Date(`${addDays(to, 1)}T00:00:00${IST_OFFSET}`),
    },
  };
}

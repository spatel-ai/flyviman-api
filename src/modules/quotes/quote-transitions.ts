import { QuoteStatus } from '../../generated/prisma/enums.js';

/**
 * The quote status machine (docs/architecture/state-machines.md, Quote):
 * `DRAFT` → `SENT` → `ACCEPTED` | `REJECTED` | `EXPIRED` | `SUPERSEDED`.
 * Pure, so it is unit tested. A sent quote is never edited: a revision is a
 * new quote, and the one it replaces is `SUPERSEDED`.
 */

export type QuoteAction = 'send' | 'accept' | 'reject' | 'expire' | 'supersede';

export type QuoteMove =
  | { to: QuoteStatus }
  | { refused: 'QUOTE_EXPIRED' | 'QUOTE_INVALID_TRANSITION' };

const Q = QuoteStatus;

/** Whether a quote may still be answered by the customer at `now`. */
export function isLive(
  quote: { status: QuoteStatus; validUntil: Date },
  now: Date,
): boolean {
  return quote.status === Q.SENT && quote.validUntil.getTime() > now.getTime();
}

/**
 * Where `action` takes a quote. The customer answers (`accept`, `reject`)
 * only a sent quote within its validity: one past `validUntil` is refused as
 * expired even before the expiry job has marked it. `expire` and `supersede`
 * close a sent quote (the job, an operator's revision or rejection).
 */
export function quoteMove(
  quote: { status: QuoteStatus; validUntil: Date },
  action: QuoteAction,
  now: Date,
): QuoteMove {
  switch (action) {
    case 'send':
      return quote.status === Q.DRAFT
        ? { to: Q.SENT }
        : { refused: 'QUOTE_INVALID_TRANSITION' };
    case 'accept':
    case 'reject':
      if (isLive(quote, now)) {
        return { to: action === 'accept' ? Q.ACCEPTED : Q.REJECTED };
      }
      return quote.status === Q.SENT || quote.status === Q.EXPIRED
        ? { refused: 'QUOTE_EXPIRED' }
        : { refused: 'QUOTE_INVALID_TRANSITION' };
    case 'expire':
      return quote.status === Q.SENT
        ? { to: Q.EXPIRED }
        : { refused: 'QUOTE_INVALID_TRANSITION' };
    case 'supersede':
      return quote.status === Q.SENT || quote.status === Q.DRAFT
        ? { to: Q.SUPERSEDED }
        : { refused: 'QUOTE_INVALID_TRANSITION' };
  }
}

/**
 * The booking's quote as its status machine sees it: the newest quote,
 * `LIVE` while it can be answered, `LAPSED` once sent and past its validity
 * (or marked expired), `NONE` otherwise.
 */
export function quoteStanding(
  newest: { status: QuoteStatus; validUntil: Date } | null,
  now: Date,
): 'NONE' | 'LIVE' | 'LAPSED' {
  if (!newest) return 'NONE';
  if (isLive(newest, now)) return 'LIVE';
  return newest.status === Q.SENT || newest.status === Q.EXPIRED
    ? 'LAPSED'
    : 'NONE';
}

/**
 * When a new quote lapses: the operator's `validUntil`, or `hours` from now
 * (`BOOKING_HOLD_HOURS`), never after the first departure.
 */
export function quoteValidUntil(
  now: Date,
  departureAt: Date,
  hours: number,
  requested?: Date,
): Date {
  const fallback = new Date(now.getTime() + hours * 3_600_000);
  const chosen = requested ?? fallback;
  return new Date(Math.min(chosen.getTime(), departureAt.getTime()));
}

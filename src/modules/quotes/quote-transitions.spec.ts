import { describe, expect, it } from 'vitest';
import { QuoteStatus } from '../../generated/prisma/enums.js';
import {
  isLive,
  type QuoteAction,
  quoteMove,
  quoteStanding,
  quoteValidUntil,
} from './quote-transitions.js';

const Q = QuoteStatus;
const NOW = new Date('2026-11-20T10:00:00.000Z');
const LATER = new Date('2026-11-21T10:00:00.000Z');
const EARLIER = new Date('2026-11-20T09:00:00.000Z');

function quote(status: QuoteStatus, validUntil = LATER) {
  return { status, validUntil };
}

describe('quoteMove', () => {
  it('sends only a draft', () => {
    expect(quoteMove(quote(Q.DRAFT), 'send', NOW)).toEqual({ to: Q.SENT });
    for (const status of [Q.SENT, Q.ACCEPTED, Q.SUPERSEDED]) {
      expect(quoteMove(quote(status), 'send', NOW)).toEqual({
        refused: 'QUOTE_INVALID_TRANSITION',
      });
    }
  });

  it('lets the customer answer a sent quote within its validity', () => {
    expect(quoteMove(quote(Q.SENT), 'accept', NOW)).toEqual({
      to: Q.ACCEPTED,
    });
    expect(quoteMove(quote(Q.SENT), 'reject', NOW)).toEqual({
      to: Q.REJECTED,
    });
  });

  it('refuses a stale quote as expired, even before the job marks it', () => {
    for (const action of ['accept', 'reject'] as QuoteAction[]) {
      expect(quoteMove(quote(Q.SENT, EARLIER), action, NOW)).toEqual({
        refused: 'QUOTE_EXPIRED',
      });
      expect(quoteMove(quote(Q.SENT, NOW), action, NOW)).toEqual({
        refused: 'QUOTE_EXPIRED',
      });
      expect(quoteMove(quote(Q.EXPIRED), action, NOW)).toEqual({
        refused: 'QUOTE_EXPIRED',
      });
    }
  });

  it('never answers a quote twice, or a superseded one', () => {
    for (const status of [Q.ACCEPTED, Q.REJECTED, Q.SUPERSEDED, Q.DRAFT]) {
      for (const action of ['accept', 'reject'] as QuoteAction[]) {
        expect(quoteMove(quote(status), action, NOW)).toEqual({
          refused: 'QUOTE_INVALID_TRANSITION',
        });
      }
    }
  });

  it('expires and supersedes only an open quote', () => {
    expect(quoteMove(quote(Q.SENT), 'expire', NOW)).toEqual({
      to: Q.EXPIRED,
    });
    expect(quoteMove(quote(Q.SENT), 'supersede', NOW)).toEqual({
      to: Q.SUPERSEDED,
    });
    // Running the expiry job twice: the second finds nothing to move.
    for (const status of [Q.EXPIRED, Q.ACCEPTED, Q.REJECTED, Q.SUPERSEDED]) {
      expect(quoteMove(quote(status), 'expire', NOW)).toEqual({
        refused: 'QUOTE_INVALID_TRANSITION',
      });
      expect(quoteMove(quote(status), 'supersede', NOW)).toEqual({
        refused: 'QUOTE_INVALID_TRANSITION',
      });
    }
  });
});

describe('quoteStanding', () => {
  it('reads the newest quote', () => {
    expect(quoteStanding(null, NOW)).toBe('NONE');
    expect(quoteStanding(quote(Q.SENT), NOW)).toBe('LIVE');
    expect(quoteStanding(quote(Q.SENT, EARLIER), NOW)).toBe('LAPSED');
    expect(quoteStanding(quote(Q.EXPIRED), NOW)).toBe('LAPSED');
    expect(quoteStanding(quote(Q.ACCEPTED), NOW)).toBe('NONE');
    expect(quoteStanding(quote(Q.REJECTED), NOW)).toBe('NONE');
  });

  it('is live only strictly before validUntil', () => {
    expect(isLive(quote(Q.SENT, NOW), NOW)).toBe(false);
  });
});

describe('quoteValidUntil', () => {
  const departure = new Date('2026-11-30T06:00:00.000Z');

  it('defaults to the configured hours', () => {
    expect(quoteValidUntil(NOW, departure, 48)).toEqual(
      new Date('2026-11-22T10:00:00.000Z'),
    );
  });

  it('takes the operator’s own validity, never past departure', () => {
    expect(quoteValidUntil(NOW, departure, 48, LATER)).toEqual(LATER);
    expect(
      quoteValidUntil(NOW, departure, 48, new Date('2026-12-05T00:00:00Z')),
    ).toEqual(departure);
    expect(
      quoteValidUntil(NOW, new Date('2026-11-21T00:00:00.000Z'), 48),
    ).toEqual(new Date('2026-11-21T00:00:00.000Z'));
  });
});

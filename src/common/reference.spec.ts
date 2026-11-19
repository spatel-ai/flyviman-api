import { describe, expect, it } from 'vitest';
import {
  BOOKING_REFERENCE,
  QUOTE_REFERENCE,
  bookingReference,
  quoteReference,
} from './reference.js';

describe('reference', () => {
  it('makes booking and quote references in their formats', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(bookingReference()).toMatch(BOOKING_REFERENCE);
      expect(quoteReference()).toMatch(QUOTE_REFERENCE);
    }
  });

  it('uses only characters that cannot be misread', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 31; i += 1) {
      seen.add(bookingReference(() => i).slice(-1));
    }
    expect(seen.size).toBe(31);
    for (const confusable of ['0', 'O', '1', 'I', 'L']) {
      expect(seen.has(confusable)).toBe(false);
    }
  });

  it('draws each character from the random source', () => {
    const draws = [0, 30, 1, 29, 2, 28];
    let call = 0;
    expect(bookingReference(() => draws[call++] ?? 0)).toBe('FLY-BK-2Z3Y4X');
    expect(call).toBe(6);
  });

  it('does not repeat in practice', () => {
    const refs = new Set(
      Array.from({ length: 1000 }, () => bookingReference()),
    );
    expect(refs.size).toBeGreaterThan(990);
  });
});

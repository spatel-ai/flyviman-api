import * as crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hmacSha256Hex, signatureMatches } from './payment-signature.js';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

describe('payment signatures', () => {
  beforeEach(() => {
    vi.mocked(crypto.timingSafeEqual).mockClear();
  });

  it('is the hex HMAC-SHA256 Razorpay documents', () => {
    // RFC 4231 test case 2.
    expect(hmacSha256Hex('Jefe', 'what do ya want for nothing?')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });

  it('compares equal-length signatures in constant time', () => {
    const expected = hmacSha256Hex('secret', 'order_1|pay_1');
    expect(signatureMatches(expected, expected)).toBe(true);
    expect(
      signatureMatches(expected, hmacSha256Hex('secret', 'order_1|pay_2')),
    ).toBe(false);
    expect(crypto.timingSafeEqual).toHaveBeenCalledTimes(2);
  });

  it('refuses a missing or wrong-length signature without throwing', () => {
    const expected = hmacSha256Hex('secret', 'order_1|pay_1');
    expect(signatureMatches(expected, undefined)).toBe(false);
    expect(signatureMatches(expected, expected.slice(1))).toBe(false);
    expect(signatureMatches(expected, '')).toBe(false);
  });
});

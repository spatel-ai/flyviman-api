import { createHmac, timingSafeEqual } from 'node:crypto';

/** Hex HMAC-SHA256, the signature scheme Razorpay uses for both checks. */
export function hmacSha256Hex(secret: string, data: string | Buffer): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

/** Constant-time comparison; false for a missing or wrong-length value. */
export function signatureMatches(
  expected: string,
  received: string | undefined,
): boolean {
  if (typeof received !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

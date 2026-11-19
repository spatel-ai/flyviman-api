import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * The visitor's address as the web host saw it, signed by the web host
 * (`flyviman-web/src/lib/client-address.ts`). Behind the web host's `/api/v1`
 * proxy every request reaches this API from the host's own addresses; this
 * header lets rate limits and the sign-in lockout count each visitor apart.
 *
 * Value: `<address> <unix seconds> <base64url HMAC-SHA256>`, the HMAC taken
 * over `flyviman-client-ip:v1\n<address>\n<seconds>` with WEB_PROXY_SECRET.
 */
export const CLIENT_ADDRESS_HEADER = 'x-flyviman-client-ip';

/** How far the signing time may be from this server's clock, either way. */
export const CLIENT_ADDRESS_MAX_SKEW_SECONDS = 60;

function signature(address: string, seconds: number, secret: string): string {
  return createHmac('sha256', secret)
    .update(`flyviman-client-ip:v1\n${address}\n${seconds}`)
    .digest('base64url');
}

/** The header value for an address. The web host signs; tests use this. */
export function signClientAddress(
  address: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  return `${address} ${nowSeconds} ${signature(address, nowSeconds, secret)}`;
}

/**
 * The address in a header value, or null unless the signature verifies with
 * this secret, the signing time is within the allowed skew and the address
 * is a plain IPv4 or IPv6 address.
 */
export function verifyClientAddress(
  value: string | undefined,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): string | null {
  const parts = value?.split(' ');
  if (parts?.length !== 3) return null;
  const [address, time, given] = parts;
  if (!/^\d{1,12}$/.test(time)) return null;
  const seconds = Number(time);
  if (Math.abs(nowSeconds - seconds) > CLIENT_ADDRESS_MAX_SKEW_SECONDS) {
    return null;
  }
  const expected = Buffer.from(signature(address, seconds, secret));
  const actual = Buffer.from(given);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return null;
  }
  return isIP(address) ? address : null;
}

const verified = new WeakMap<object, string>();

/**
 * Records the signed visitor address of each request whose header verifies.
 * Without a secret (local development, tests) the header is never trusted,
 * so behaviour is exactly as before: the socket address (`request.ip`).
 *
 * A header that fails to verify is ignored too, with one warning per
 * process (D-123): it usually means the two hosts' secrets or clocks
 * differ, which silently puts every visitor back on one shared identity.
 * The warning never includes the header's value or the secret.
 */
export function clientAddressMiddleware(
  secret: string | undefined,
  logger: Pick<Logger, 'warn'> = new Logger('ClientAddress'),
) {
  let warned = false;
  return (request: Request, _response: Response, next: NextFunction): void => {
    const header = secret ? request.header(CLIENT_ADDRESS_HEADER) : undefined;
    const address = header ? verifyClientAddress(header, secret!) : null;
    if (address) {
      verified.set(request, address);
    } else if (header && !warned) {
      warned = true;
      logger.warn(
        `A ${CLIENT_ADDRESS_HEADER} header failed verification and was ignored; check that WEB_PROXY_SECRET matches on both hosts and their clocks agree. Further failures are not logged.`,
      );
    }
    next();
  };
}

/** The verified visitor address carried by the web host, if any. */
export function signedClientAddress(request: object): string | undefined {
  return verified.get(request);
}

/**
 * Who sent this request: the verified visitor address when the web host
 * passed one on, otherwise the connection's address.
 */
export function clientAddress(request: {
  ip?: string | undefined;
}): string | null {
  return verified.get(request) ?? request.ip ?? null;
}

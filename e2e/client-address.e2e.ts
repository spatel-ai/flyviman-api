import { expect, test } from '@playwright/test';
import { WEB_PROXY_SECRET } from '../playwright.config.js';
import {
  CLIENT_ADDRESS_HEADER,
  signClientAddress,
} from '../src/common/middleware/client-address.middleware.js';
import { STRICT_BASE_URL } from './support/accounts.js';
import { uniqueEmail } from './support/data.js';
import { asVisitor, visitorAddress } from './support/visitor.js';

/**
 * Behind the web host's /api/v1 proxy every request comes from the host's
 * address. The host passes each visitor's address on in a signed header, and
 * the API counts rate limits and the sign-in lockout by it, but only when the
 * signature verifies.
 */

/** Headers a visitor could send straight to the API, each claiming a new address. */
function madeUpHeaders(): Record<string, string>[] {
  const now = Math.floor(Date.now() / 1000);
  // Correctly signed, an hour ago: an expired header is not replayed.
  const signedLongAgo = signClientAddress(
    visitorAddress(),
    WEB_PROXY_SECRET,
    now - 3600,
  );
  return [
    { [CLIENT_ADDRESS_HEADER]: `${visitorAddress()} ${now} forged` },
    { [CLIENT_ADDRESS_HEADER]: visitorAddress() },
    { [CLIENT_ADDRESS_HEADER]: signedLongAgo },
  ];
}

test.describe('rate limits behind the web host', () => {
  test('each signed visitor has an allowance of its own', async ({
    playwright,
  }) => {
    const request = await playwright.request.newContext({
      baseURL: STRICT_BASE_URL,
    });
    // The search tier allows 20 a minute per caller and route; the limit is
    // counted before validation, so an empty query is enough.
    const busy = asVisitor(visitorAddress());
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 21; attempt += 1) {
      statuses.push(
        (await request.get('search/calendar', { headers: busy })).status(),
      );
    }
    expect(statuses.slice(0, 20)).not.toContain(429);
    expect(statuses[20]).toBe(429);

    const other = await request.get('search/calendar', {
      headers: asVisitor(visitorAddress()),
    });
    expect(other.status()).not.toBe(429);
    expect(other.headers()['ratelimit-remaining']).toBe('19');
    await request.dispose();
  });

  test('a header that does not verify is ignored', async ({ playwright }) => {
    const request = await playwright.request.newContext({
      baseURL: STRICT_BASE_URL,
    });
    // Each request claims a new address. Were any honoured, each would get a
    // fresh allowance and none would be refused; ignored, they all count
    // against this connection's address and the 21st is refused.
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      for (const headers of madeUpHeaders()) {
        statuses.push(
          (await request.get('search/calendar', { headers })).status(),
        );
      }
    }
    expect(statuses).toHaveLength(21);
    expect(statuses[20]).toBe(429);
    await request.dispose();
  });
});

test.describe('sign-in lockout behind the web host', () => {
  test('locks the email for the signed visitor that failed, not for others', async ({
    request,
  }) => {
    const email = uniqueEmail('lockout');
    const attempt = (headers: Record<string, string>) =>
      request.post('auth/login', {
        headers,
        data: { email, password: 'not-the-password' },
      });

    const guesser = visitorAddress();
    for (let failure = 0; failure < 10; failure += 1) {
      expect((await attempt(asVisitor(guesser))).status()).toBe(401);
    }
    const locked = await attempt(asVisitor(guesser));
    expect(locked.status()).toBe(429);
    expect((await locked.json()).error.code).toBe('RATE_LIMITED');

    // Another visitor, and the connection itself, are not locked out.
    expect((await attempt(asVisitor(visitorAddress()))).status()).toBe(401);
    expect((await attempt({})).status()).toBe(401);
    // A made-up header naming the guesser's address is not believed.
    expect(
      (
        await attempt({
          [CLIENT_ADDRESS_HEADER]: `${guesser} ${Math.floor(Date.now() / 1000)} forged`,
        })
      ).status(),
    ).toBe(401);
  });
});

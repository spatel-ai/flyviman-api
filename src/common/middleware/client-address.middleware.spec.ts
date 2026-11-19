import type { Request, Response } from 'express';
import {
  CLIENT_ADDRESS_HEADER,
  clientAddress,
  clientAddressMiddleware,
  signClientAddress,
  signedClientAddress,
  verifyClientAddress,
} from './client-address.middleware.js';

const SECRET = 'test-secret-of-at-least-32-characters!!';
const NOW = 1763510400;
/** The same vector is in flyviman-web/src/lib/client-address.spec.ts. */
const VECTOR =
  '203.0.113.7 1763510400 Sk8T9XctyR94OHpLNZrh7MhLPszOEZbDJTV0rigKEXM';

function fakeRequest(header: string | undefined, ip = '10.0.0.1') {
  return {
    ip,
    header: (name: string) =>
      name === CLIENT_ADDRESS_HEADER ? header : undefined,
  } as unknown as Request;
}

describe('client address signing', () => {
  it('signs to the shared vector and verifies it', () => {
    expect(signClientAddress('203.0.113.7', SECRET, NOW)).toBe(VECTOR);
    expect(verifyClientAddress(VECTOR, SECRET, NOW)).toBe('203.0.113.7');
  });

  it('verifies IPv6 addresses', () => {
    const value = signClientAddress('2001:db8::1', SECRET, NOW);
    expect(verifyClientAddress(value, SECRET, NOW)).toBe('2001:db8::1');
  });

  it('refuses a tampered address, time or signature', () => {
    const [, time, sig] = VECTOR.split(' ');
    expect(
      verifyClientAddress(`203.0.113.8 ${time} ${sig}`, SECRET, NOW),
    ).toBeNull();
    expect(
      verifyClientAddress(`203.0.113.7 ${NOW + 1} ${sig}`, SECRET, NOW),
    ).toBeNull();
    expect(
      verifyClientAddress(
        `203.0.113.7 ${time} ${sig.slice(0, -1)}A`,
        SECRET,
        NOW,
      ),
    ).toBeNull();
    expect(
      verifyClientAddress(`203.0.113.7 ${time} short`, SECRET, NOW),
    ).toBeNull();
  });

  it('refuses a value signed with another secret', () => {
    const forged = signClientAddress('203.0.113.7', 'x'.repeat(32), NOW);
    expect(verifyClientAddress(forged, SECRET, NOW)).toBeNull();
  });

  it('refuses a signing time more than 60 seconds away, either way', () => {
    expect(verifyClientAddress(VECTOR, SECRET, NOW + 60)).toBe('203.0.113.7');
    expect(verifyClientAddress(VECTOR, SECRET, NOW - 60)).toBe('203.0.113.7');
    expect(verifyClientAddress(VECTOR, SECRET, NOW + 61)).toBeNull();
    expect(verifyClientAddress(VECTOR, SECRET, NOW - 61)).toBeNull();
  });

  it('refuses missing and malformed values', () => {
    for (const value of [
      undefined,
      '',
      '203.0.113.7',
      `203.0.113.7 ${NOW}`,
      `${VECTOR} extra`,
      `203.0.113.7 -1 x`,
      `203.0.113.7 1e9 x`,
    ]) {
      expect(verifyClientAddress(value, SECRET, NOW)).toBeNull();
    }
  });

  it('refuses a correctly signed value that is not an IP address', () => {
    const value = signClientAddress('not-an-address', SECRET, NOW);
    expect(verifyClientAddress(value, SECRET, NOW)).toBeNull();
  });
});

describe('clientAddressMiddleware', () => {
  function run(secret: string | undefined, header: string | undefined) {
    const request = fakeRequest(header);
    const next = vi.fn();
    clientAddressMiddleware(secret, { warn: vi.fn() })(
      request,
      {} as Response,
      next,
    );
    expect(next).toHaveBeenCalledOnce();
    return request;
  }

  it('uses a verified visitor address', () => {
    const request = run(SECRET, signClientAddress('203.0.113.7', SECRET));
    expect(signedClientAddress(request)).toBe('203.0.113.7');
    expect(clientAddress(request)).toBe('203.0.113.7');
  });

  it('ignores a header a visitor made up and keeps the connection address', () => {
    const request = run(
      SECRET,
      `203.0.113.7 ${Math.floor(Date.now() / 1000)} forged`,
    );
    expect(signedClientAddress(request)).toBeUndefined();
    expect(clientAddress(request)).toBe('10.0.0.1');
  });

  it('ignores an expired header', () => {
    const request = run(SECRET, signClientAddress('203.0.113.7', SECRET, NOW));
    expect(clientAddress(request)).toBe('10.0.0.1');
  });

  it('ignores the header entirely when no secret is configured', () => {
    const request = run(undefined, signClientAddress('203.0.113.7', SECRET));
    expect(signedClientAddress(request)).toBeUndefined();
    expect(clientAddress(request)).toBe('10.0.0.1');
  });

  it('falls back to the connection address without a header', () => {
    expect(clientAddress(run(SECRET, undefined))).toBe('10.0.0.1');
  });

  it('warns once when a header fails verification, without its value', () => {
    const logger = { warn: vi.fn() };
    const middleware = clientAddressMiddleware(SECRET, logger);
    const forged = `203.0.113.7 ${Math.floor(Date.now() / 1000)} forged`;
    for (const header of [forged, forged, undefined]) {
      const request = fakeRequest(header);
      middleware(request, {} as Response, vi.fn());
      expect(clientAddress(request)).toBe('10.0.0.1');
    }
    expect(logger.warn).toHaveBeenCalledOnce();
    const message = String(logger.warn.mock.calls[0][0]);
    expect(message).not.toContain('203.0.113.7');
    expect(message).not.toContain(SECRET);
  });

  it('does not warn for valid headers, or with no secret', () => {
    const logger = { warn: vi.fn() };
    const signed = clientAddressMiddleware(SECRET, logger);
    signed(
      fakeRequest(signClientAddress('203.0.113.7', SECRET)),
      {} as Response,
      vi.fn(),
    );
    clientAddressMiddleware(undefined, logger)(
      fakeRequest('203.0.113.7 1 forged'),
      {} as Response,
      vi.fn(),
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

import type { Response } from 'express';
import {
  CSRF_COOKIE,
  REFRESH_COOKIE,
  setSessionCookies,
  type SessionTokens,
} from './auth.cookies.js';

describe('setSessionCookies', () => {
  it('gives a replayed pair kept without its end the usual refresh lifetime', () => {
    const response = { cookie: vi.fn() };
    // As kept in Redis by the version before refreshExpiresAt existed.
    const legacy = {
      accessToken: 'access',
      refreshToken: 'refresh',
      csrfToken: 'csrf',
    } as SessionTokens;

    setSessionCookies(response as unknown as Response, legacy, {
      secure: false,
      accessTtlSeconds: 900,
      refreshTtlSeconds: 3600,
    });

    for (const name of [REFRESH_COOKIE, CSRF_COOKIE]) {
      expect(response.cookie).toHaveBeenCalledWith(
        name,
        expect.any(String),
        expect.objectContaining({ maxAge: 3_600_000 }),
      );
    }
  });
});

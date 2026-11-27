import type { CookieOptions, Response } from 'express';

export const ACCESS_COOKIE = 'access_token';
export const REFRESH_COOKIE = 'refresh_token';
export const CSRF_COOKIE = 'csrf_token';
export const CSRF_HEADER = 'x-csrf-token';

export interface CookieSettings {
  secure: boolean;
  domain?: string;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
}

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  csrfToken: string;
  /**
   * When the refresh token ends (epoch milliseconds): its own lifetime, or
   * the end of the sign-in if sooner. Kept with a replayed pair, so the
   * cookies of every request it serves end at the same moment.
   */
  refreshExpiresAt: number;
}

function base(settings: CookieSettings): CookieOptions {
  return {
    secure: settings.secure,
    sameSite: 'lax',
    path: '/',
    ...(settings.domain ? { domain: settings.domain } : {}),
  };
}

/**
 * The two session cookies are unreadable by scripts. The CSRF cookie is
 * readable on purpose: the web client copies it into `X-CSRF-Token`.
 */
export function setSessionCookies(
  response: Response,
  tokens: SessionTokens,
  settings: CookieSettings,
): void {
  const options = base(settings);
  // The browser drops the refresh cookie when the token ends, which is
  // sooner than its usual lifetime near the end of the sign-in. A pair kept
  // for replay before tokens carried their end has the usual lifetime.
  const refreshMaxAge = Number.isFinite(tokens.refreshExpiresAt)
    ? Math.max(0, tokens.refreshExpiresAt - Date.now())
    : settings.refreshTtlSeconds * 1000;
  response.cookie(ACCESS_COOKIE, tokens.accessToken, {
    ...options,
    httpOnly: true,
    maxAge: settings.accessTtlSeconds * 1000,
  });
  response.cookie(REFRESH_COOKIE, tokens.refreshToken, {
    ...options,
    httpOnly: true,
    maxAge: refreshMaxAge,
  });
  response.cookie(CSRF_COOKIE, tokens.csrfToken, {
    ...options,
    httpOnly: false,
    maxAge: refreshMaxAge,
  });
}

export function clearSessionCookies(
  response: Response,
  settings: CookieSettings,
): void {
  const options = base(settings);
  for (const name of [ACCESS_COOKIE, REFRESH_COOKIE, CSRF_COOKIE]) {
    response.clearCookie(name, options);
  }
}

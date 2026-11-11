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
  response.cookie(ACCESS_COOKIE, tokens.accessToken, {
    ...options,
    httpOnly: true,
    maxAge: settings.accessTtlSeconds * 1000,
  });
  response.cookie(REFRESH_COOKIE, tokens.refreshToken, {
    ...options,
    httpOnly: true,
    maxAge: settings.refreshTtlSeconds * 1000,
  });
  response.cookie(CSRF_COOKIE, tokens.csrfToken, {
    ...options,
    httpOnly: false,
    maxAge: settings.refreshTtlSeconds * 1000,
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

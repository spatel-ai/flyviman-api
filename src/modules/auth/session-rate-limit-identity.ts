import { Injectable } from '@nestjs/common';
import { RateLimitIdentity } from '../../common/rate-limit/rate-limit.js';
import { ACCESS_COOKIE, REFRESH_COOKIE } from './auth.cookies.js';
import { AuthService } from './auth.service.js';
import { TokenService } from './token.service.js';

type Cookies = Record<string, string | undefined>;

/** How the rate limiter recognises a session (see `RateLimitGuard`). */
@Injectable()
export class SessionRateLimitIdentity extends RateLimitIdentity {
  constructor(
    private readonly tokens: TokenService,
    private readonly auth: AuthService,
  ) {
    super();
  }

  /**
   * Racing refreshes of one token (a page's link prefetches after an idle
   * spell) are not counted: only one can rotate it, and the rest receive
   * the same pair, at most REFRESH_REPLAY_MAX times (D-111). A refresh
   * with no cookie is still counted by address.
   */
  async exempt(request: Record<string, any>): Promise<boolean> {
    if (!String(request.path ?? '').endsWith('/auth/refresh')) return false;
    const refresh = ((request.cookies ?? {}) as Cookies)[REFRESH_COOKIE];
    return refresh
      ? this.auth.isRefreshInPlay(refresh).catch(() => false)
      : false;
  }

  /**
   * - A refresh is counted against the refresh token presented when that
   *   token belongs to a session. A token that matches none (made up, or
   *   unreadable) is counted by address, so inventing a new token each
   *   time does not get a fresh allowance.
   * - Any other request with an access token whose signature verifies is
   *   counted against that user. Sign-in and registration never carry one
   *   that matters, so they stay counted by address.
   */
  async identify(request: Record<string, any>): Promise<string | null> {
    const cookies = (request.cookies ?? {}) as Cookies;
    const path = String(request.path ?? '');
    if (path.endsWith('/auth/refresh')) {
      const refresh = cookies[REFRESH_COOKIE];
      if (!refresh) return null;
      const known = await this.auth.isRefreshKnown(refresh).catch(() => false);
      return known ? `refresh:${this.tokens.hashToken(refresh)}` : null;
    }
    if (path.includes('/auth/')) return null;
    const access = cookies[ACCESS_COOKIE];
    const claims = access ? await this.tokens.verifyAccessToken(access) : null;
    return claims ? `user:${claims.sub}` : null;
  }
}

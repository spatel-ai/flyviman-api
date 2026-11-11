import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { CookieSettings } from './auth.cookies.js';

export interface AccessTokenClaims {
  /** User ID. */
  sub: string;
  /** Session family ID. */
  sid: string;
}

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  get cookieSettings(): CookieSettings {
    return {
      secure: this.config.get('NODE_ENV') === 'production',
      domain: this.config.get<string>('COOKIE_DOMAIN') || undefined,
      accessTtlSeconds: this.config.getOrThrow<number>(
        'ACCESS_TOKEN_TTL_SECONDS',
      ),
      refreshTtlSeconds:
        this.config.getOrThrow<number>('REFRESH_TOKEN_TTL_DAYS') * 86_400,
    };
  }

  signAccessToken(claims: AccessTokenClaims): Promise<string> {
    return this.jwt.signAsync(claims);
  }

  /** Returns the claims, or `null` for a missing, forged or expired token. */
  async verifyAccessToken(token: string): Promise<AccessTokenClaims | null> {
    try {
      const claims = await this.jwt.verifyAsync<AccessTokenClaims>(token);
      return typeof claims.sub === 'string' && typeof claims.sid === 'string'
        ? claims
        : null;
    } catch {
      return null;
    }
  }

  /** An opaque random value; used for refresh tokens and CSRF tokens. */
  randomToken(): string {
    return randomBytes(32).toString('base64url');
  }

  /** Refresh tokens are stored only as this hash. */
  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}

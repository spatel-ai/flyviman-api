import { ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import {
  ThrottlerGuard,
  ThrottlerModuleOptions,
  ThrottlerOptionsFactory,
} from '@nestjs/throttler';

export type RateTier = 'auth' | 'default';
const RATE_TIER = 'rateTier';

/**
 * Puts a controller or route on the strict sign-in tier. Everything else is
 * on the default tier. Limits per tier: docs/architecture/security-rbac.md.
 */
export const StrictRateLimit = () => SetMetadata(RATE_TIER, 'auth' as RateTier);

@Injectable()
export class RateLimitConfig implements ThrottlerOptionsFactory {
  constructor(
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  createThrottlerOptions(): ThrottlerModuleOptions {
    const limits: Record<RateTier, number> = {
      auth: this.config.getOrThrow<number>('RATE_LIMIT_AUTH_PER_MINUTE'),
      default: this.config.getOrThrow<number>('RATE_LIMIT_DEFAULT_PER_MINUTE'),
    };
    return [
      {
        name: 'default',
        ttl: 60_000,
        limit: (context: ExecutionContext) => {
          const tier =
            this.reflector.getAllAndOverride<RateTier | undefined>(RATE_TIER, [
              context.getHandler(),
              context.getClass(),
            ]) ?? 'default';
          return limits[tier];
        },
      },
    ];
  }
}

/**
 * Who a request is counted against. Returns `null` to count by address.
 * Set by the auth module, which knows how to recognise a session.
 */
export type RateLimitIdentity = (
  request: Record<string, any>,
) => Promise<string | null>;

/**
 * Counts each caller separately and sends the standard `RateLimit-*`
 * headers instead of the `X-` variants.
 *
 * A request that proves a session is counted against that session, not its
 * address. This matters because the web server makes API calls for every
 * signed-in user from one address: counted by address, a few users (or one
 * person reloading a page) would exhaust everyone's allowance.
 */
@Injectable()
export class RateLimitGuard extends ThrottlerGuard {
  protected headerPrefix = 'RateLimit';
  static identify: RateLimitIdentity = async () => null;

  protected async getTracker(request: Record<string, any>): Promise<string> {
    return (
      (await RateLimitGuard.identify(request)) ?? super.getTracker(request)
    );
  }
}

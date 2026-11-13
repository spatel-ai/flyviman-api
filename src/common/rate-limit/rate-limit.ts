import { ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import {
  ThrottlerGuard,
  type ThrottlerLimitDetail,
  ThrottlerModuleOptions,
  ThrottlerOptionsFactory,
} from '@nestjs/throttler';

export type RateTier = 'auth' | 'search' | 'default';
const RATE_TIER = 'rateTier';

/**
 * Puts a controller or route on the strict sign-in tier. Everything else is
 * on the default tier. Limits per tier: docs/architecture/security-rbac.md.
 */
export const StrictRateLimit = () => SetMetadata(RATE_TIER, 'auth' as RateTier);

/**
 * Puts a route on the search tier (`RATE_LIMIT_SEARCH_PER_MINUTE`): public
 * routes that compute prices or write a search record (M5, D-099).
 */
export const SearchRateLimit = () =>
  SetMetadata(RATE_TIER, 'search' as RateTier);

const ENQUIRY_LIMIT = 'enquiryLimit';

/**
 * Adds a second, longer-window limit to a public form that sends a message
 * to staff (the contact page's enquiries): `RATE_LIMIT_ENQUIRY_PER_WINDOW`
 * requests per `RATE_LIMIT_ENQUIRY_WINDOW_SECONDS`, per caller, on top of
 * the default tier. Response headers carry the `-enquiry` suffix.
 */
export const EnquiryRateLimit = () => SetMetadata(ENQUIRY_LIMIT, true);

@Injectable()
export class RateLimitConfig implements ThrottlerOptionsFactory {
  constructor(
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  createThrottlerOptions(): ThrottlerModuleOptions {
    const limits: Record<RateTier, number> = {
      auth: this.config.getOrThrow<number>('RATE_LIMIT_AUTH_PER_MINUTE'),
      search: this.config.getOrThrow<number>('RATE_LIMIT_SEARCH_PER_MINUTE'),
      default: this.config.getOrThrow<number>('RATE_LIMIT_DEFAULT_PER_MINUTE'),
    };
    // Its own number, never tied to the sign-in tier: raising the sign-in
    // limit must not raise the public spam limit. Test servers set it.
    const enquiryLimit = this.config.getOrThrow<number>(
      'RATE_LIMIT_ENQUIRY_PER_WINDOW',
    );
    const enquiryWindowMs =
      this.config.getOrThrow<number>('RATE_LIMIT_ENQUIRY_WINDOW_SECONDS') *
      1000;
    return [
      {
        name: 'enquiry',
        ttl: enquiryWindowMs,
        limit: enquiryLimit,
        skipIf: (context: ExecutionContext) =>
          !this.reflector.getAllAndOverride<boolean | undefined>(
            ENQUIRY_LIMIT,
            [context.getHandler(), context.getClass()],
          ),
      },
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

  /**
   * A named limit other than `default` sets `Retry-After-<name>`; clients
   * read the standard `Retry-After` (api-design.md), so it is set too.
   */
  protected async throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    const response = context.switchToHttp().getResponse<{
      setHeader(name: string, value: number): void;
    }>();
    response.setHeader('Retry-After', detail.timeToBlockExpire);
    return super.throwThrottlingException(context, detail);
  }
}

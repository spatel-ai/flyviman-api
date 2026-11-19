import type { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Reflector } from '@nestjs/core';
import { RateLimitConfig, RateLimitGuard } from './rate-limit.js';

function context(request: object): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('RateLimitGuard exemptions', () => {
  const original = RateLimitGuard.exempt;
  afterEach(() => {
    RateLimitGuard.exempt = original;
  });

  // `shouldSkip` is protected; called on the prototype with a bare receiver.
  const shouldSkip = (request: object) =>
    (
      RateLimitGuard.prototype as unknown as {
        shouldSkip(context: ExecutionContext): Promise<boolean>;
      }
    ).shouldSkip.call({}, context(request));

  it('does not count a request the auth module exempts (a racing refresh)', async () => {
    const request = { path: '/api/v1/auth/refresh' };
    RateLimitGuard.exempt = vi.fn().mockResolvedValue(true);
    await expect(shouldSkip(request)).resolves.toBe(true);
    expect(RateLimitGuard.exempt).toHaveBeenCalledWith(request);
  });

  it('counts every other request', async () => {
    RateLimitGuard.exempt = vi.fn().mockResolvedValue(false);
    await expect(shouldSkip({ path: '/api/v1/me' })).resolves.toBe(false);
  });
});

describe('RateLimitConfig tiers', () => {
  const LIMITS: Record<string, number> = {
    RATE_LIMIT_AUTH_PER_MINUTE: 5,
    RATE_LIMIT_SEARCH_PER_MINUTE: 20,
    RATE_LIMIT_DEFAULT_PER_MINUTE: 100,
    RATE_LIMIT_WEBHOOK_PER_MINUTE: 120,
    RATE_LIMIT_ENQUIRY_PER_WINDOW: 5,
    RATE_LIMIT_ENQUIRY_WINDOW_SECONDS: 600,
  };

  function limitFor(tier: string | undefined): number {
    const config = { getOrThrow: (name: string) => LIMITS[name] };
    const reflector = { getAllAndOverride: () => tier };
    const options = new RateLimitConfig(
      config as unknown as ConfigService,
      reflector as unknown as Reflector,
    ).createThrottlerOptions() as Array<{
      name: string;
      limit: (context: ExecutionContext) => number;
    }>;
    const fallback = options.find((option) => option.name === 'default')!;
    return fallback.limit({
      getHandler: () => undefined,
      getClass: () => undefined,
    } as unknown as ExecutionContext);
  }

  it('puts webhooks on their own, generous tier', () => {
    expect(limitFor('webhook')).toBe(120);
    expect(limitFor(undefined)).toBe(100);
    expect(limitFor('auth')).toBe(5);
  });
});

import type { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Reflector } from '@nestjs/core';
import type { ThrottlerStorage } from '@nestjs/throttler';
import {
  RateLimitConfig,
  RateLimitGuard,
  RateLimitIdentity,
} from './rate-limit.js';

function context(request: object): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

/** The guard alone, with a stand-in for the identity the auth module provides. */
function guard(identity: Partial<RateLimitIdentity> = {}) {
  const fake = {
    identify: vi.fn().mockResolvedValue(null),
    exempt: vi.fn().mockResolvedValue(false),
    ...identity,
  };
  const instance = new RateLimitGuard(
    [],
    {} as ThrottlerStorage,
    {} as Reflector,
    fake as RateLimitIdentity,
  ) as unknown as {
    shouldSkip(context: ExecutionContext): Promise<boolean>;
    getTracker(request: Record<string, unknown>): Promise<string>;
  };
  return { instance, fake };
}

describe('RateLimitGuard exemptions', () => {
  it('does not count a request the identity exempts (a racing refresh)', async () => {
    const request = { path: '/api/v1/auth/refresh' };
    const { instance, fake } = guard({
      exempt: vi.fn().mockResolvedValue(true),
    });
    await expect(instance.shouldSkip(context(request))).resolves.toBe(true);
    expect(fake.exempt).toHaveBeenCalledWith(request);
  });

  it('counts every other request', async () => {
    const { instance } = guard();
    await expect(
      instance.shouldSkip(context({ path: '/api/v1/me' })),
    ).resolves.toBe(false);
  });
});

describe('RateLimitGuard tracker', () => {
  it('counts a recognised session against that session', async () => {
    const request = { path: '/api/v1/me', ip: '203.0.113.7' };
    const { instance, fake } = guard({
      identify: vi.fn().mockResolvedValue('user:user-1'),
    });
    await expect(instance.getTracker(request)).resolves.toBe('user:user-1');
    expect(fake.identify).toHaveBeenCalledWith(request);
  });

  it('counts by address when the identity recognises none', async () => {
    const { instance } = guard();
    await expect(
      instance.getTracker({ path: '/api/v1/me', ip: '203.0.113.7' }),
    ).resolves.toBe('203.0.113.7');
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

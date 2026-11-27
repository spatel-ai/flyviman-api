import type { ConfigService } from '@nestjs/config';
import type { Reflector } from '@nestjs/core';
import type { Redis } from 'ioredis';
import { RateLimitConfig } from './rate-limit.js';
import {
  RATE_LIMIT_REDIS_TIMEOUT_MS,
  RedisThrottlerStorage,
} from './redis-throttler-storage.js';

// The script itself runs against a real Redis in e2e/rate-limit-storage.e2e.ts.
describe('RedisThrottlerStorage', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts in one script call, under its own prefix, in milliseconds', async () => {
    const redis = { eval: vi.fn().mockResolvedValue([3, 58, 0, 0]) };
    const storage = new RedisThrottlerStorage(
      redis as unknown as Redis,
      'rate-limit',
    );

    await expect(
      storage.increment('abc', 60_000, 5, 60_000, 'default'),
    ).resolves.toEqual({
      totalHits: 3,
      timeToExpire: 58,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
    const [script, keys, ...rest] = redis.eval.mock.calls[0] as unknown[];
    expect(script).toContain("redis.call('TIME')");
    expect(script).toContain("redis.call('PEXPIRE', KEYS[1], keep)");
    expect(script).toContain("redis.call('PEXPIRE', KEYS[2], keep)");
    expect([keys, ...rest]).toEqual([
      2,
      'rate-limit:abc:hits',
      'rate-limit:abc',
      60_000,
      5,
      60_000,
    ]);
  });

  it('reports a block', async () => {
    const redis = { eval: vi.fn().mockResolvedValue([6, 40, 1, 60]) };
    const storage = new RedisThrottlerStorage(
      redis as unknown as Redis,
      'rate-limit',
    );
    await expect(
      storage.increment('abc', 60_000, 5, 60_000, 'default'),
    ).resolves.toEqual({
      totalHits: 6,
      timeToExpire: 40,
      isBlocked: true,
      timeToBlockExpire: 60,
    });
  });

  it('counts in memory when Redis fails, warning once until it recovers', async () => {
    const redis = {
      eval: vi
        .fn()
        .mockRejectedValueOnce(new Error('down'))
        .mockRejectedValueOnce(new Error('down'))
        .mockResolvedValueOnce([1, 60, 0, 0])
        .mockRejectedValueOnce(new Error('down')),
    };
    const storage = new RedisThrottlerStorage(
      redis as unknown as Redis,
      'rate-limit',
    );
    const warn = vi
      .spyOn(
        (storage as unknown as { logger: { warn: () => void } }).logger,
        'warn',
      )
      .mockImplementation(() => undefined);

    await expect(
      storage.increment('abc', 600_000, 5, 600_000, 'enquiry'),
    ).resolves.toMatchObject({ totalHits: 1, isBlocked: false });
    await expect(
      storage.increment('abc', 600_000, 5, 600_000, 'enquiry'),
    ).resolves.toMatchObject({ totalHits: 2, isBlocked: false });
    expect(warn).toHaveBeenCalledTimes(1);
    await storage.increment('abc', 600_000, 5, 600_000, 'enquiry');
    await storage.increment('abc', 600_000, 5, 600_000, 'enquiry');
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('still blocks over the limit while Redis is down', async () => {
    const redis = { eval: vi.fn().mockRejectedValue(new Error('down')) };
    const storage = new RedisThrottlerStorage(
      redis as unknown as Redis,
      'rate-limit',
    );
    vi.spyOn(
      (storage as unknown as { logger: { warn: () => void } }).logger,
      'warn',
    ).mockImplementation(() => undefined);

    for (let hit = 1; hit <= 3; hit += 1) {
      await expect(
        storage.increment('abc', 60_000, 3, 60_000, 'default'),
      ).resolves.toMatchObject({ totalHits: hit, isBlocked: false });
    }
    await expect(
      storage.increment('abc', 60_000, 3, 60_000, 'default'),
    ).resolves.toMatchObject({ totalHits: 4, isBlocked: true });
    // Another key is counted separately.
    await expect(
      storage.increment('other', 60_000, 3, 60_000, 'default'),
    ).resolves.toMatchObject({ totalHits: 1, isBlocked: false });
  });

  it('falls back to memory when Redis is slow', async () => {
    vi.useFakeTimers();
    const redis = { eval: vi.fn(() => new Promise(() => undefined)) };
    const storage = new RedisThrottlerStorage(
      redis as unknown as Redis,
      'rate-limit',
    );
    vi.spyOn(
      (storage as unknown as { logger: { warn: () => void } }).logger,
      'warn',
    ).mockImplementation(() => undefined);

    const result = storage.increment('abc', 60_000, 5, 60_000, 'default');
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_REDIS_TIMEOUT_MS);
    await expect(result).resolves.toMatchObject({
      totalHits: 1,
      isBlocked: false,
    });
  });

  it('refuses a throttler without a block duration', async () => {
    const redis = { eval: vi.fn() };
    const storage = new RedisThrottlerStorage(
      redis as unknown as Redis,
      'rate-limit',
    );
    await expect(
      storage.increment('abc', 60_000, 5, 0, 'default'),
    ).rejects.toThrow('block duration');
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('is the store the rate-limit configuration uses, with the configured prefix', () => {
    const config = {
      getOrThrow: (name: string) =>
        name === 'RATE_LIMIT_KEY_PREFIX' ? 'e2e-run-strict' : 1,
    };
    const options = new RateLimitConfig(
      config as unknown as ConfigService,
      {} as Reflector,
      {} as Redis,
    ).createThrottlerOptions() as { storage: unknown };
    expect(options.storage).toBeInstanceOf(RedisThrottlerStorage);
    expect(options.storage).toMatchObject({ prefix: 'e2e-run-strict' });
  });
});

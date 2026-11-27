import { Logger } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { Redis } from 'ioredis';

/** The package does not export its record type from its entry point. */
type ThrottlerStorageRecord = Awaited<
  ReturnType<ThrottlerStorage['increment']>
>;

/**
 * Longest a request waits on Redis for its count. Redis answers in well
 * under a millisecond; a slow or absent one must not hold every request.
 */
export const RATE_LIMIT_REDIS_TIMEOUT_MS = 250;

/**
 * One hit, counted as `@nestjs/throttler`'s in-memory store counts it, so the
 * limits behave exactly as before:
 * - each hit expires on its own `ttl` after it was made (a sliding window);
 * - the hit that goes over the limit blocks the key for the block duration,
 *   during which hits are not counted;
 * - the first hit after the block lapses starts the count again at 1;
 * - `timeToExpire` is a fixed window per key, restarted once it has passed.
 * Times use Redis's clock, so every instance agrees on them. Both keys always
 * carry an expiry: the longer of the window and what is left of the block.
 *
 * KEYS[1]: sorted set of hits (member: a sequence number, score: when the
 *          hit expires, in milliseconds)
 * KEYS[2]: hash with `expiresAt`, `blockedUntil` (0 when not blocked), `seq`
 * ARGV: ttl (ms), limit, block duration (ms)
 * Returns: total hits, seconds to expire, blocked (1 or 0), seconds to the
 *          end of the block (0 when not blocked).
 */
const INCREMENT = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local ttl = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local block = tonumber(ARGV[3])

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local expiresAt = tonumber(redis.call('HGET', KEYS[2], 'expiresAt') or 0)
if expiresAt <= now then
  expiresAt = now + ttl
  redis.call('HSET', KEYS[2], 'expiresAt', expiresAt)
end

local blockedUntil = tonumber(redis.call('HGET', KEYS[2], 'blockedUntil') or 0)
if blockedUntil > 0 and blockedUntil <= now then
  redis.call('DEL', KEYS[1])
  blockedUntil = 0
  redis.call('HSET', KEYS[2], 'blockedUntil', 0)
end

if blockedUntil == 0 then
  local seq = redis.call('HINCRBY', KEYS[2], 'seq', 1)
  redis.call('ZADD', KEYS[1], now + ttl, seq)
end
local hits = redis.call('ZCARD', KEYS[1])
if blockedUntil == 0 and hits > limit then
  blockedUntil = now + block
  redis.call('HSET', KEYS[2], 'blockedUntil', blockedUntil)
end

local keep = math.max(ttl, blockedUntil - now)
redis.call('PEXPIRE', KEYS[1], keep)
redis.call('PEXPIRE', KEYS[2], keep)

local blocked = 0
local blockLeft = 0
if blockedUntil > 0 then
  blocked = 1
  blockLeft = math.ceil((blockedUntil - now) / 1000)
end
return { hits, math.ceil((expiresAt - now) / 1000), blocked, blockLeft }
`;

function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Timed out')), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Rate-limit counters in Redis, shared by every instance of the API and kept
 * across restarts. One script per hit, so concurrent requests on several
 * instances count exactly once each.
 *
 * Redis down or slow: that hit is counted in this process's memory instead,
 * so limits still apply per process (as before Redis), with one warning
 * until Redis answers again. Refusing outright would turn a Redis outage
 * into an API outage, health and payment webhooks included.
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);
  private failing = false;
  private fallback?: ThrottlerStorage;

  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
  ) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    _throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    // The guard passes `blockDuration ?? ttl` and no throttler here sets
    // one, so the store's non-blocking mode is never used.
    if (blockDuration <= 0) {
      throw new Error('A rate limit needs a positive block duration.');
    }
    const base = `${this.prefix}:${key}`;
    let reply: [number, number, number, number];
    try {
      reply = (await within(
        this.redis.eval(
          INCREMENT,
          2,
          `${base}:hits`,
          base,
          ttl,
          limit,
          blockDuration,
        ),
        RATE_LIMIT_REDIS_TIMEOUT_MS,
      )) as [number, number, number, number];
    } catch {
      if (!this.failing) {
        this.failing = true;
        this.logger.warn(
          'Could not count a request in Redis; counting in memory',
        );
      }
      // Loaded on first use: Playwright's loader cannot import the package,
      // and e2e/rate-limit-storage.e2e.ts imports this file.
      this.fallback ??= new (
        await import('@nestjs/throttler')
      ).ThrottlerStorageService();
      return this.fallback.increment(
        key,
        ttl,
        limit,
        blockDuration,
        _throttlerName,
      );
    }
    this.failing = false;
    const [totalHits, timeToExpire, isBlocked, timeToBlockExpire] = reply;
    return {
      totalHits,
      timeToExpire,
      isBlocked: isBlocked === 1,
      timeToBlockExpire,
    };
  }
}

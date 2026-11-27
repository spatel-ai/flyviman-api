import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { Redis } from 'ioredis';
import { RedisThrottlerStorage } from '../src/common/rate-limit/redis-throttler-storage.js';

// The rate limiter's counting script against the real Redis the API uses:
// counters shared by every instance and kept across restarts.
const PREFIX = 'e2e-storage';
const MINUTE = 60_000;

let connections: Redis[] = [];

/** A storage on its own connection, as another API instance would have. */
function instance(): RedisThrottlerStorage {
  const redis = new Redis(process.env.REDIS_URL!);
  connections.push(redis);
  return new RedisThrottlerStorage(redis, PREFIX);
}

test.afterEach(async () => {
  const [redis] = connections;
  const keys = await redis.keys(`${PREFIX}:*`);
  if (keys.length) await redis.del(...keys);
  for (const connection of connections) connection.disconnect();
  connections = [];
});

test('counts hits and blocks the one over the limit for the block duration', async () => {
  const storage = instance();
  const key = randomUUID();
  const totals = [];
  for (let hit = 0; hit < 3; hit += 1) {
    const record = await storage.increment(key, MINUTE, 3, MINUTE, 'default');
    expect(record.isBlocked).toBe(false);
    expect(record.timeToBlockExpire).toBe(0);
    expect(record.timeToExpire).toBeGreaterThan(55);
    expect(record.timeToExpire).toBeLessThanOrEqual(60);
    totals.push(record.totalHits);
  }
  expect(totals).toEqual([1, 2, 3]);

  const over = await storage.increment(key, MINUTE, 3, MINUTE, 'default');
  expect(over).toMatchObject({ totalHits: 4, isBlocked: true });
  expect(over.timeToBlockExpire).toBe(60);
  // While blocked, hits are not counted.
  const again = await storage.increment(key, MINUTE, 3, MINUTE, 'default');
  expect(again).toMatchObject({ totalHits: 4, isBlocked: true });
});

test('two instances share one count, and a new one sees it', async () => {
  const [first, second] = [instance(), instance()];
  const key = randomUUID();
  await first.increment(key, MINUTE, 5, MINUTE, 'default');
  await first.increment(key, MINUTE, 5, MINUTE, 'default');
  expect(
    (await second.increment(key, MINUTE, 5, MINUTE, 'default')).totalHits,
  ).toBe(3);
  // A restarted instance (new connection, new storage) carries on counting.
  expect(
    (await instance().increment(key, MINUTE, 5, MINUTE, 'default')).totalHits,
  ).toBe(4);
});

test('concurrent hits on several instances are each counted once', async () => {
  const storages = [instance(), instance(), instance()];
  const key = randomUUID();
  const records = await Promise.all(
    Array.from({ length: 30 }, (_, index) =>
      storages[index % 3].increment(key, MINUTE, 100, MINUTE, 'default'),
    ),
  );
  expect(
    records.map((record) => record.totalHits).sort((a, b) => a - b),
  ).toEqual(Array.from({ length: 30 }, (_, index) => index + 1));
});

test('hits expire after the window, and no key outlives it', async () => {
  const storage = instance();
  const [redis] = connections;
  const key = randomUUID();
  await storage.increment(key, 300, 5, 300, 'default');
  await storage.increment(key, 300, 5, 300, 'default');
  for (const name of [`${PREFIX}:${key}`, `${PREFIX}:${key}:hits`]) {
    const ttl = await redis.pttl(name);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(300);
  }
  await expect
    .poll(() => redis.exists(`${PREFIX}:${key}`, `${PREFIX}:${key}:hits`))
    .toBe(0);
  expect((await storage.increment(key, 300, 5, 300, 'default')).totalHits).toBe(
    1,
  );
});

test('when the block lapses, the next hit starts the count again', async () => {
  const storage = instance();
  const [redis] = connections;
  const key = randomUUID();
  await storage.increment(key, MINUTE, 1, 300, 'default');
  const blocked = await storage.increment(key, MINUTE, 1, 300, 'default');
  expect(blocked).toMatchObject({ isBlocked: true, timeToBlockExpire: 1 });
  // A short block still keeps the keys for the whole window.
  expect(await redis.pttl(`${PREFIX}:${key}:hits`)).toBeGreaterThan(55_000);

  let last = blocked;
  await expect
    .poll(async () => {
      // Hits made while blocked are not counted, so polling is harmless.
      last = await storage.increment(key, MINUTE, 1, 300, 'default');
      return last.isBlocked;
    })
    .toBe(false);
  expect(last).toMatchObject({ totalHits: 1, timeToBlockExpire: 0 });
});

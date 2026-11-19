import type { Redis } from 'ioredis';
import { IdempotencyPurge } from './idempotency-purge.js';
import type { IdempotencyStore } from './idempotency.store.js';

function setup(locked: 'OK' | null = 'OK') {
  const redis = {
    set: vi.fn().mockResolvedValue(locked),
    eval: vi.fn().mockResolvedValue(1),
  };
  const store = { purgeExpired: vi.fn().mockResolvedValue(4) };
  const purge = new IdempotencyPurge(
    store as unknown as IdempotencyStore,
    redis as unknown as Redis,
  );
  return { purge, redis, store };
}

describe('IdempotencyPurge', () => {
  const NOW = new Date('2026-11-19T21:30:00.000Z');

  it('deletes keys past their window under a lock, then releases it', async () => {
    const { purge, redis, store } = setup();
    await expect(purge.run(NOW)).resolves.toEqual({
      deleted: 4,
      skipped: false,
    });
    expect(store.purgeExpired).toHaveBeenCalledWith(NOW);
    const [key, token, , , mode] = redis.set.mock.calls[0] as string[];
    expect([key, mode]).toEqual(['idempotency:purge:lock', 'NX']);
    // Released with this run's own token only.
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('get', KEYS[1]) == ARGV[1]"),
      1,
      'idempotency:purge:lock',
      token,
    );
  });

  it('skips while another instance holds the lock', async () => {
    const { purge, store, redis } = setup(null);
    await expect(purge.run(NOW)).resolves.toEqual({
      deleted: 0,
      skipped: true,
    });
    expect(store.purgeExpired).not.toHaveBeenCalled();
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('releases the lock when the delete fails, and the daily run survives', async () => {
    const { purge, store, redis } = setup();
    store.purgeExpired.mockRejectedValue(new Error('database down'));
    await expect(purge.daily()).resolves.toBeUndefined();
    expect(redis.eval).toHaveBeenCalled();
  });
});

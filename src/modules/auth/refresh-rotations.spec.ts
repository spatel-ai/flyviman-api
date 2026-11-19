import type { Redis } from 'ioredis';
import { RefreshRotations, ROTATION_WINDOW_MS } from './refresh-rotations.js';

describe('RefreshRotations', () => {
  it('counts per sign-in in a one-minute window, atomically', async () => {
    const redis = { eval: vi.fn().mockResolvedValue(3) };
    const rotations = new RefreshRotations(redis as unknown as Redis);

    await expect(rotations.count('family-1')).resolves.toBe(3);
    const [script, keys, key, windowMs] = redis.eval.mock.calls[0] as [
      string,
      number,
      string,
      number,
    ];
    expect(script).toContain("redis.call('INCR'");
    expect(script).toContain("redis.call('PEXPIRE'");
    expect([keys, key, windowMs]).toEqual([
      1,
      'refresh-rotations:family-1',
      ROTATION_WINDOW_MS,
    ]);
    expect(ROTATION_WINDOW_MS).toBe(60_000);
  });

  it('passes Redis errors to the caller', async () => {
    const redis = { eval: vi.fn().mockRejectedValue(new Error('down')) };
    const rotations = new RefreshRotations(redis as unknown as Redis);
    await expect(rotations.count('family-1')).rejects.toThrow('down');
  });
});

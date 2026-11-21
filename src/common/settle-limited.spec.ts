import { describe, expect, it } from 'vitest';
import { settleLimited } from './settle-limited.js';

describe('settleLimited', () => {
  it('keeps the order of the items and settles each', async () => {
    const results = await settleLimited([1, 2, 3, 4], 2, async (n) => {
      await new Promise((r) => setTimeout(r, (5 - n) * 2));
      if (n === 3) throw new Error('no');
      return n * 10;
    });
    expect(results.map((r) => r.status)).toEqual([
      'fulfilled',
      'fulfilled',
      'rejected',
      'fulfilled',
    ]);
    expect(results[0]).toEqual({ status: 'fulfilled', value: 10 });
    expect(results[3]).toEqual({ status: 'fulfilled', value: 40 });
  });

  it('never runs more than the limit at once', async () => {
    let running = 0;
    let most = 0;
    await settleLimited(
      Array.from({ length: 20 }, (_, i) => i),
      3,
      async () => {
        running += 1;
        most = Math.max(most, running);
        await new Promise((r) => setTimeout(r, 1));
        running -= 1;
      },
    );
    expect(most).toBe(3);
  });

  it('an empty list settles at once', async () => {
    expect(await settleLimited([], 5, async () => 1)).toEqual([]);
  });
});

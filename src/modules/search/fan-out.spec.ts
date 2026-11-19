import { callAll } from './fan-out.js';

describe('callAll', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps the answers in time and marks the slow and failing suppliers', async () => {
    const pending = callAll<number>(
      [
        { name: 'fast', run: () => Promise.resolve(1) },
        {
          name: 'slow',
          run: () =>
            new Promise((resolve) => setTimeout(() => resolve(2), 5000)),
        },
        { name: 'broken', run: () => Promise.reject(new Error('down')) },
        {
          name: 'throws',
          run: () => {
            throw new Error('sync');
          },
        },
      ],
      1000,
    );
    await vi.advanceTimersByTimeAsync(1000);
    const outcomes = await pending;
    expect(outcomes.map((o) => [o.name, o.status])).toEqual([
      ['fast', 'OK'],
      ['slow', 'TIMEOUT'],
      ['broken', 'ERROR'],
      ['throws', 'ERROR'],
    ]);
    expect(outcomes[0]).toMatchObject({ value: 1 });
    expect(vi.getTimerCount()).toBe(1); // only the slow supplier's own timer
  });

  it('answers at once when every supplier is in time', async () => {
    const outcomes = await callAll(
      [{ name: 'a', run: () => Promise.resolve('x') }],
      1000,
    );
    expect(outcomes).toEqual([{ name: 'a', status: 'OK', value: 'x' }]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

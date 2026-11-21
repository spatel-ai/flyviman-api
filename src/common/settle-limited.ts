/**
 * `Promise.allSettled(items.map(run))` with at most `limit` calls running at
 * once. Results are in the order of `items`.
 */
export async function settleLimited<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: 'fulfilled', value: await run(items[i]) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, worker),
  );
  return results;
}

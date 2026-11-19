/** How one supplier answered a scheduled search. */
export type ProviderCallStatus = 'OK' | 'TIMEOUT' | 'ERROR';

export type ProviderCallOutcome<T> =
  | { name: string; status: 'OK'; value: T }
  | { name: string; status: 'TIMEOUT' | 'ERROR'; error?: unknown };

const TIMED_OUT = Symbol('timed out');

/**
 * Calls every supplier at once and waits at most `timeoutMs` for each. A
 * supplier that has not answered by then is `TIMEOUT` and its late answer
 * is discarded; one that rejects is `ERROR`. Never rejects itself, so one
 * supplier cannot fail the others (partial results).
 */
export function callAll<T>(
  calls: { name: string; run: () => Promise<T> }[],
  timeoutMs: number,
): Promise<ProviderCallOutcome<T>[]> {
  return Promise.all(
    calls.map(async ({ name, run }): Promise<ProviderCallOutcome<T>> => {
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      });
      try {
        const value = await Promise.race([
          // A synchronous throw becomes a rejection here.
          Promise.resolve().then(run),
          deadline,
        ]);
        if (value === TIMED_OUT) return { name, status: 'TIMEOUT' };
        return { name, status: 'OK', value };
      } catch (error) {
        return { name, status: 'ERROR', error };
      } finally {
        clearTimeout(timer);
      }
    }),
  );
}

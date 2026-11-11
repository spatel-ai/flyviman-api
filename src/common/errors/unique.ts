/**
 * Runs inserts; `null` if a unique constraint stopped them, which means a
 * concurrent request created the same record first.
 */
export async function uniqueOrNull<T>(
  run: () => Promise<T>,
): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    if ((error as { code?: unknown }).code === 'P2002') return null;
    throw error;
  }
}

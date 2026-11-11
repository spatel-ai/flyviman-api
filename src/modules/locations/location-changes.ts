/** Structural equality for the JSON-like values a location holds. */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The fields of `update` that differ from `current`, with their values on
 * both sides. Fields left out of the update are not compared. The result is
 * what the audit record stores and what the database update writes.
 */
export function changedFields<T extends object>(
  current: T,
  update: Partial<T>,
): { before: Partial<T>; after: Partial<T> } {
  const before: Partial<T> = {};
  const after: Partial<T> = {};
  for (const key of Object.keys(update) as (keyof T)[]) {
    const next = update[key];
    if (next === undefined || same(current[key], next)) continue;
    before[key] = current[key];
    after[key] = next;
  }
  return { before, after };
}

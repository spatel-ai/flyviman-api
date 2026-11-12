/**
 * Whether two JSON values are equal by value: object key order is ignored,
 * array order is not. `undefined` and `null` are treated as the same, so a
 * stored `null` column equals a cleared field.
 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  return canonical(a ?? null) === canonical(b ?? null);
}

function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(source)
        .sort()
        .map((key) => [key, sortKeys(source[key])]),
    );
  }
  return value;
}

/** Escapes `%`, `_` and `\` so user input matches literally in LIKE. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * The search term as the query uses it: trimmed, inner whitespace collapsed,
 * or `null` when nothing is left.
 */
export function normaliseSearchTerm(value: string | undefined): string | null {
  const term = value?.trim().replace(/\s+/g, ' ');
  return term ? term : null;
}

/**
 * Three or four letters, the shape of an IATA or ICAO code. Only such terms
 * match ICAO codes by prefix: every Indian ICAO code starts with V, so a
 * shorter term would match almost everything.
 */
export function looksLikeCode(term: string): boolean {
  return /^[a-z]{3,4}$/i.test(term);
}

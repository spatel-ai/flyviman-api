import { randomInt } from 'node:crypto';

/** No 0, O, 1, I or L: a reference is read aloud and typed by hand. */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const LENGTH = 6;

export const BOOKING_REFERENCE =
  /^FLY-BK-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/;
export const QUOTE_REFERENCE = /^FLY-QT-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/;
export const EMPTY_LEG_REFERENCE =
  /^FLY-EL-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/;
export const AIR_AMBULANCE_REFERENCE =
  /^FLY-AA-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/;

/**
 * A human-facing reference such as `FLY-BK-7K2M9Q` (31^6 codes). Not unique
 * by itself: the column's unique index is, and the caller draws again on a
 * conflict (P2002), as enquiries do.
 */
function reference(
  prefix: string,
  random: (max: number) => number = randomInt,
): string {
  let code = '';
  for (let i = 0; i < LENGTH; i += 1) {
    code += ALPHABET[random(ALPHABET.length)];
  }
  return `${prefix}-${code}`;
}

export function bookingReference(random?: (max: number) => number): string {
  return reference('FLY-BK', random);
}

export function quoteReference(random?: (max: number) => number): string {
  return reference('FLY-QT', random);
}

export function emptyLegReference(random?: (max: number) => number): string {
  return reference('FLY-EL', random);
}

export function airAmbulanceReference(
  random?: (max: number) => number,
): string {
  return reference('FLY-AA', random);
}

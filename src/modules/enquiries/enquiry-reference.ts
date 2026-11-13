import { randomInt } from 'node:crypto';

/** No 0, O, 1, I or L: a reference is read aloud and typed by hand. */
export const REFERENCE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const LENGTH = 6;
export const ENQUIRY_REFERENCE =
  /^FLY-ENQ-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/;

/** `FLY-ENQ-7K2M9Q`, in the style of booking references (`FLY-BK-…`). */
export function enquiryReference(random: (max: number) => number = randomInt) {
  let code = '';
  for (let i = 0; i < LENGTH; i += 1) {
    code += REFERENCE_ALPHABET[random(REFERENCE_ALPHABET.length)];
  }
  return `FLY-ENQ-${code}`;
}

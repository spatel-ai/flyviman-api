import { ValidateBy } from 'class-validator';

/**
 * Control characters and text-direction overrides, which can make text read
 * differently in an admin screen from what was stored. Line breaks and tabs
 * are allowed only when `lineBreaks` is set (a multi-line reason).
 */
export function hasHiddenCharacter(
  text: string,
  { lineBreaks = false }: { lineBreaks?: boolean } = {},
): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (lineBreaks && (code === 0x09 || code === 0x0a || code === 0x0d)) {
      continue;
    }
    if (
      code < 0x20 ||
      code === 0x7f ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      return true;
    }
  }
  return false;
}

/** Plain text: line breaks allowed, other hidden characters refused. */
export const IsPlainText = () =>
  ValidateBy({
    name: 'isPlainText',
    validator: {
      validate: (value: unknown) =>
        typeof value !== 'string' ||
        !hasHiddenCharacter(value, { lineBreaks: true }),
      defaultMessage: () =>
        '$property must not contain control or text-direction characters',
    },
  });

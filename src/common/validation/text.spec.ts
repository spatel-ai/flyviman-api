import { describe, expect, it } from 'vitest';
import { hasHiddenCharacter } from './text.js';

describe('hasHiddenCharacter', () => {
  it('finds control and text-direction characters', () => {
    expect(hasHiddenCharacter('GST')).toBe(false);
    expect(hasHiddenCharacter('GST‮81')).toBe(true);
    expect(hasHiddenCharacter('a\u0000b')).toBe(true);
    expect(hasHiddenCharacter('two\nlines')).toBe(true);
  });

  it('allows line breaks and tabs when asked', () => {
    const options = { lineBreaks: true };
    expect(hasHiddenCharacter('two\nlines\r\n\tindented', options)).toBe(false);
    expect(hasHiddenCharacter('still ⁦hidden', options)).toBe(true);
  });
});

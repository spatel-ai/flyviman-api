import { matchesDeclaredType } from './file-signature.js';

const PDF = new TextEncoder().encode('%PDF-1.7 ...');
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0,
]);

describe('matchesDeclaredType', () => {
  it('accepts content that matches its declared type', () => {
    expect(matchesDeclaredType('application/pdf', PDF)).toBe(true);
    expect(matchesDeclaredType('image/png', PNG)).toBe(true);
    expect(
      matchesDeclaredType(
        'image/jpeg',
        Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]),
      ),
    ).toBe(true);
  });

  it('refuses content declared as another type', () => {
    expect(matchesDeclaredType('application/pdf', PNG)).toBe(false);
    expect(matchesDeclaredType('image/png', PDF)).toBe(false);
  });

  it('refuses types that are not on the list and empty content', () => {
    expect(matchesDeclaredType('text/html', PDF)).toBe(false);
    expect(matchesDeclaredType('application/pdf', new Uint8Array())).toBe(
      false,
    );
  });
});

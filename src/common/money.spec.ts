import { minorToNumber } from './money.js';

describe('minorToNumber', () => {
  it('returns amounts above the old 32-bit ceiling as exact integers', () => {
    expect(minorToNumber(3_000_000_000n)).toBe(3_000_000_000);
    expect(minorToNumber(0n)).toBe(0);
    expect(minorToNumber(-125n)).toBe(-125);
    expect(minorToNumber(BigInt(Number.MAX_SAFE_INTEGER))).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it('refuses an amount it cannot represent exactly', () => {
    expect(() => minorToNumber(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow(
      RangeError,
    );
  });
});

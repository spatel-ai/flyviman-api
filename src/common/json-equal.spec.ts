import { describe, expect, it } from 'vitest';
import { jsonEqual } from './json-equal.js';

describe('jsonEqual', () => {
  it('ignores object key order, at any depth', () => {
    expect(
      jsonEqual(
        { a: 1, b: { x: [1, 2], y: 'z' } },
        { b: { y: 'z', x: [1, 2] }, a: 1 },
      ),
    ).toBe(true);
  });

  it('keeps array order significant', () => {
    expect(jsonEqual([1, 2], [2, 1])).toBe(false);
  });

  it('treats null and undefined as the same', () => {
    expect(jsonEqual(null, undefined)).toBe(true);
    expect(jsonEqual({}, null)).toBe(false);
  });

  it('sees a changed value', () => {
    expect(jsonEqual({ ventilator: true }, { ventilator: false })).toBe(false);
    expect(jsonEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });
});

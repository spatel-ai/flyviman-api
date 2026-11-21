import { describe, expect, it } from 'vitest';
import {
  entryTexts,
  WARNING_AUDIENCE,
  WARNING_CODES,
  visibleWarnings,
} from './notes.js';

describe('calculation viewer warnings by role', () => {
  const stored = [
    {
      code: 'CHARGE_NOT_ON_RECORD',
      text: 'Landing charges at X are not on record.',
    },
    { code: 'COMMISSION_MISSING', text: 'No commission rule is in force.' },
    {
      code: 'REVENUE_NEGATIVE',
      text: 'Flyviman earns less than nothing on this trip after the override.',
    },
    'An older warning without a code',
  ];

  it('gives finance and super admins every warning, older ones included', () => {
    expect(visibleWarnings(stored, true)).toEqual([
      'Landing charges at X are not on record.',
      'No commission rule is in force.',
      'Flyviman earns less than nothing on this trip after the override.',
      'An older warning without a code',
    ]);
  });

  it('gives operations no commission or revenue warning, and nothing it cannot classify', () => {
    expect(visibleWarnings(stored, false)).toEqual([
      'Landing charges at X are not on record.',
    ]);
  });

  it('classifies every warning code', () => {
    expect(Object.keys(WARNING_AUDIENCE).sort()).toEqual(
      [...WARNING_CODES].sort(),
    );
    for (const code of [
      'REVENUE_NEGATIVE',
      'COMMISSION_MISSING',
      'COMMISSION_INCLUSIVE_IGNORED',
    ] as const) {
      expect(WARNING_AUDIENCE[code], code).toBe('FINANCE');
    }
  });

  it('reads nothing from a value that is not a list', () => {
    expect(entryTexts(null)).toEqual([]);
    expect(visibleWarnings({ code: 'NOT_PRICED' }, false)).toEqual([]);
  });
});

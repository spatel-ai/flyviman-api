import { describe, expect, it } from 'vitest';
import {
  ADMIN_RULE_TYPES,
  checkRuleConfig,
  checkScopeRef,
  isAdminRuleType,
} from './admin-rule-config.js';

const CATEGORIES = ['LIGHT_JET', 'HELICOPTER_LIGHT'] as never;

describe('checkRuleConfig', () => {
  it('accepts a commission and keeps only its fields', () => {
    expect(
      checkRuleConfig('COMMISSION', { percent: 12.5, mode: 'DEDUCTED' }),
    ).toEqual({ ok: true, config: { percent: 12.5, mode: 'DEDUCTED' } });
  });

  it('refuses an unknown field, a missing field and a bad mode together', () => {
    const result = checkRuleConfig('COMMISSION', {
      mode: 'SOMETIMES',
      extra: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.field).sort()).toEqual([
      'config.extra',
      'config.mode',
      'config.percent',
    ]);
  });

  it('treats built-in object names as unknown fields', () => {
    const result = checkRuleConfig('COMMISSION', {
      percent: 10,
      mode: 'ADD_ON',
      toString: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.field)).toEqual(['config.toString']);
  });

  it('bounds percentages and decimals', () => {
    expect(checkRuleConfig('TAX', { name: 'GST', percent: 41 }).ok).toBe(false);
    expect(checkRuleConfig('TAX', { name: 'GST', percent: 18.005 }).ok).toBe(
      false,
    );
    expect(checkRuleConfig('TAX', { name: 'GST', percent: 0 }).ok).toBe(true);
  });

  it('trims a tax name and refuses control or direction characters', () => {
    expect(checkRuleConfig('TAX', { name: '  GST ', percent: 18 })).toEqual({
      ok: true,
      config: { name: 'GST', percent: 18 },
    });
    expect(checkRuleConfig('TAX', { name: 'G‮ST', percent: 18 }).ok).toBe(
      false,
    );
  });

  it('wants whole paise and whole minutes', () => {
    expect(checkRuleConfig('MIN_CHARGE', { amountMinor: 100.5 }).ok).toBe(
      false,
    );
    expect(checkRuleConfig('VALIDITY', { minutes: 4 }).ok).toBe(false);
    expect(checkRuleConfig('VALIDITY', { minutes: 90 }).ok).toBe(true);
  });

  it('keeps the routing factor at or above 1', () => {
    expect(checkRuleConfig('ROUTING_FACTOR', { factor: 0.9 }).ok).toBe(false);
    expect(checkRuleConfig('ROUTING_FACTOR', { factor: 1.085 }).ok).toBe(true);
  });

  it('defaults an optional field', () => {
    expect(checkRuleConfig('POSITIONING', { rateFactor: 0.8 })).toEqual({
      ok: true,
      config: { rateFactor: 0.8, freeWithinKm: 0 },
    });
  });

  it('refuses a config that is not an object', () => {
    for (const config of [null, 5, 'x', [1]]) {
      expect(checkRuleConfig('TAX', config).ok).toBe(false);
    }
  });

  it('refuses a string where a number belongs', () => {
    expect(
      checkRuleConfig('COMMISSION', { percent: '10', mode: 'ADD_ON' }).ok,
    ).toBe(false);
  });
});

describe('MATCHING_LIMITS config', () => {
  it('accepts any subset of limits and leaves the rest out', () => {
    expect(
      checkRuleConfig('MATCHING_LIMITS', {
        maxLegKm: 600,
        landingSites: 'NOT_ALLOWED',
      }),
    ).toEqual({
      ok: true,
      config: { maxLegKm: 600, landingSites: 'NOT_ALLOWED' },
    });
    expect(checkRuleConfig('MATCHING_LIMITS', {})).toEqual({
      ok: true,
      config: {},
    });
  });

  it('refuses a minimum above the maximum, decimals and unknown keys', () => {
    for (const config of [
      { minLegKm: 500, maxLegKm: 100 },
      { minRunwayM: 1200.5 },
      { landingSites: 'MAYBE' },
      { regions: ['Goa'] },
    ]) {
      expect(checkRuleConfig('MATCHING_LIMITS', config).ok).toBe(false);
    }
  });
});

describe('admin rule types', () => {
  it('leaves out the operator types and keeps the platform ones', () => {
    for (const type of ['HOURLY_RATE', 'SECTOR_RATE', 'FUEL_SURCHARGE']) {
      expect(isAdminRuleType(type)).toBe(false);
    }
    for (const type of ['COMMISSION', 'MARKUP', 'SERVICE_FEE', 'DISCOUNT']) {
      expect(ADMIN_RULE_TYPES).toContain(type);
    }
  });
});

describe('markup, service fee and discount config (M5 4c)', () => {
  it('accepts each, zero included, so finance can switch one off', () => {
    expect(checkRuleConfig('MARKUP', { percent: 0 })).toEqual({
      ok: true,
      config: { percent: 0 },
    });
    expect(checkRuleConfig('SERVICE_FEE', { amountMinor: 0 }).ok).toBe(true);
    expect(
      checkRuleConfig('DISCOUNT', { name: ' Launch offer ', percent: 12.5 }),
    ).toEqual({ ok: true, config: { name: 'Launch offer', percent: 12.5 } });
  });

  it('bounds them and refuses anything else', () => {
    for (const [type, config] of [
      ['MARKUP', { percent: 50.01 }],
      ['MARKUP', { percent: 5, mode: 'ADD_ON' }],
      ['SERVICE_FEE', { amountMinor: 99.5 }],
      ['SERVICE_FEE', { amountMinor: -1 }],
      ['SERVICE_FEE', { percent: 2 }],
      ['DISCOUNT', { percent: 10 }],
      ['DISCOUNT', { name: 'X', percent: 10 }],
      ['DISCOUNT', { name: 'Offer', percent: 51 }],
      ['DISCOUNT', { name: 'Off\u202eer', percent: 10 }],
    ] as const) {
      expect(checkRuleConfig(type, config).ok).toBe(false);
    }
  });

  it('takes a per-day or per-leg minimum, and leaves `per` out when not sent', () => {
    expect(checkRuleConfig('MIN_BILLABLE_HOURS', { hours: 2 })).toEqual({
      ok: true,
      config: { hours: 2 },
    });
    expect(
      checkRuleConfig('MIN_BILLABLE_HOURS', { hours: 2, per: 'DAY' }),
    ).toEqual({ ok: true, config: { hours: 2, per: 'DAY' } });
    expect(
      checkRuleConfig('MIN_BILLABLE_HOURS', { hours: 2, per: 'WEEK' }).ok,
    ).toBe(false);
  });
});

describe('checkScopeRef', () => {
  it('wants no reference on a platform rule', () => {
    expect(checkScopeRef('PLATFORM', null, CATEGORIES)).toBeNull();
    expect(checkScopeRef('PLATFORM', 'LIGHT_JET', CATEGORIES)).not.toBeNull();
  });

  it('wants a known category on a category rule', () => {
    expect(checkScopeRef('CATEGORY', 'LIGHT_JET', CATEGORIES)).toBeNull();
    expect(checkScopeRef('CATEGORY', 'BALLOON', CATEGORIES)).not.toBeNull();
    expect(checkScopeRef('CATEGORY', undefined, CATEGORIES)).not.toBeNull();
  });
});

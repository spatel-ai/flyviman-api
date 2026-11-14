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

describe('admin rule types', () => {
  it('leaves out the types the engine does not apply yet', () => {
    for (const type of ['MARKUP', 'SERVICE_FEE', 'DISCOUNT', 'HOURLY_RATE']) {
      expect(isAdminRuleType(type)).toBe(false);
    }
    expect(ADMIN_RULE_TYPES).toContain('COMMISSION');
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

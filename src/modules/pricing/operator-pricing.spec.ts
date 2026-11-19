import { describe, expect, it } from 'vitest';
import {
  fixedRouteProblems,
  minHoursConfig,
  otherConfig,
  waitingConfig,
} from './operator-pricing.service.js';

const stored = { amountMinor: 1_000_000, freeHours: 2 };

describe('waitingConfig', () => {
  it('keeps the stored free hours when only the rate is sent', () => {
    expect(waitingConfig({ waitingHourlyMinor: 1_500_000 }, stored)).toEqual({
      amountMinor: 1_500_000,
      freeHours: 2,
    });
  });

  it('keeps the stored rate when only the free hours are sent', () => {
    expect(waitingConfig({ waitingFreeHours: 3 }, stored)).toEqual({
      amountMinor: 1_000_000,
      freeHours: 3,
    });
  });

  it('leaves the rule alone when neither is sent, and clears it on a null rate', () => {
    expect(waitingConfig({}, stored)).toBeUndefined();
    expect(
      waitingConfig({ waitingHourlyMinor: null, waitingFreeHours: 3 }, stored),
    ).toBeNull();
  });

  it('reads a null free hours as 0, and free hours alone without a rate as nothing', () => {
    expect(
      waitingConfig(
        { waitingHourlyMinor: 500, waitingFreeHours: null },
        stored,
      ),
    ).toEqual({ amountMinor: 500, freeHours: 0 });
    expect(waitingConfig({ waitingFreeHours: 3 }, undefined)).toBeUndefined();
    expect(waitingConfig({ waitingHourlyMinor: 500 }, undefined)).toEqual({
      amountMinor: 500,
      freeHours: 0,
    });
  });
});

describe('minHoursConfig', () => {
  it('stores per day, and per leg as no `per`, so an unchanged save writes nothing', () => {
    expect(minHoursConfig(2, 'DAY', undefined)).toEqual({
      hours: 2,
      per: 'DAY',
    });
    expect(minHoursConfig(2, 'LEG', { hours: 2, per: 'DAY' })).toEqual({
      hours: 2,
    });
    expect(minHoursConfig(2, null, { hours: 2, per: 'DAY' })).toEqual({
      hours: 2,
    });
  });

  it('keeps the stored `per` when it is left out, and clears on null hours', () => {
    expect(minHoursConfig(3, undefined, { hours: 2, per: 'DAY' })).toEqual({
      hours: 3,
      per: 'DAY',
    });
    expect(minHoursConfig(3, undefined, undefined)).toEqual({ hours: 3 });
    expect(minHoursConfig(null, 'DAY', { hours: 2 })).toBeNull();
  });
});

describe('otherConfig', () => {
  const stored = { label: 'Catering', amountMinor: 300_000 };

  it('keeps the stored label or amount when only the other is sent', () => {
    expect(otherConfig({ otherChargeMinor: 400_000 }, stored)).toEqual({
      label: 'Catering',
      amountMinor: 400_000,
    });
    expect(
      otherConfig({ otherChargeLabel: 'Ground transport' }, stored),
    ).toEqual({
      label: 'Ground transport',
      amountMinor: 300_000,
    });
  });

  it('leaves it alone when neither is sent, and clears it on a null amount', () => {
    expect(otherConfig({}, stored)).toBeUndefined();
    expect(
      otherConfig({ otherChargeMinor: null, otherChargeLabel: 'X1' }, stored),
    ).toBeNull();
    expect(
      otherConfig({ otherChargeLabel: 'Catering' }, undefined),
    ).toBeUndefined();
  });

  it('refuses a new charge without a name', () => {
    expect(() => otherConfig({ otherChargeMinor: 1 }, undefined)).toThrow(
      /needs a name/,
    );
  });
});

describe('fixedRouteProblems', () => {
  const A = 'a',
    B = 'b',
    C = 'c';
  const active = new Set([A, B, C]);
  const route = (originId: string, destinationId: string) => ({
    originId,
    destinationId,
    amountMinor: 1_000,
  });

  it('accepts distinct routes between active locations', () => {
    expect(
      fixedRouteProblems([route(A, B), route(A, C), route(B, C)], active),
    ).toEqual([]);
  });

  it('refuses an unknown or inactive location, a route to itself and a repeat in either direction', () => {
    expect(
      fixedRouteProblems(
        [route(A, B), route(B, A), route(C, C), route(A, 'gone')],
        active,
      ).map((problem) => problem.field),
    ).toEqual([
      'fixedRoutes[1]',
      'fixedRoutes[2].destinationId',
      'fixedRoutes[3].destinationId',
    ]);
  });
});

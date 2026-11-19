import { describe, expect, it } from 'vitest';
import { waitingConfig } from './operator-pricing.service.js';

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

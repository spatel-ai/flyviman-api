import { describe, expect, it } from 'vitest';
import { PriceType } from '../../generated/prisma/enums.js';
import { explain } from './trips.service.js';

const unknownAmount = {
  appliedCharge: { chargePercent: 50 },
  amountKnown: false,
} as Parameters<typeof explain>[0];

describe('explain', () => {
  it.each([
    [PriceType.ESTIMATE, 'an estimate'],
    [PriceType.QUOTE, 'a quote'],
    [PriceType.LIVE_FARE, 'a live fare'],
  ])('says %s in words', (priceType, words) => {
    const text = explain(unknownAmount, priceType);
    expect(text).toContain(
      `the price is still ${words}, so nothing is charged.`,
    );
    expect(text).not.toMatch(/ESTIMATE|QUOTE|LIVE_FARE/);
  });
});

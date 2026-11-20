import { expect, test } from '@playwright/test';
import { signIn } from './support/session.js';

interface Row {
  category: string;
  region: string;
  isEnabled: boolean;
  bookingMode: string;
  paymentModel: string;
  updatedAt: string;
}

test.describe('GET /admin/category-config', () => {
  for (const account of ['superAdmin', 'ops', 'finance'] as const) {
    test(`${account} reads the seeded defaults of decisions 5 and 7`, async ({
      request,
    }) => {
      await signIn(request, account);
      const response = await request.get('admin/category-config');
      expect(response.status()).toBe(200);
      const rows = (await response.json()).data as Row[];
      const india = Object.fromEntries(
        rows
          .filter((row) => row.region === 'IN')
          .map((row) => [
            row.category,
            [row.isEnabled, row.bookingMode, row.paymentModel],
          ]),
      );
      expect(india).toEqual({
        SCHEDULED_AIRLINE: [true, 'INSTANT', 'A_INSTANT'],
        PRIVATE_CHARTER: [true, 'REQUEST', 'B_OPERATOR_CONFIRMED'],
        HELICOPTER: [true, 'REQUEST', 'B_OPERATOR_CONFIRMED'],
        EMPTY_LEG: [true, 'REQUEST', 'B_OPERATOR_CONFIRMED'],
        AIR_AMBULANCE: [true, 'REQUEST', 'B_OPERATOR_CONFIRMED'],
      });
      for (const row of rows) {
        expect(Object.keys(row).sort()).toEqual([
          'bookingMode',
          'category',
          'depositPercent',
          'isEnabled',
          'paymentModel',
          'region',
          'updatedAt',
        ]);
        expect(Number.isNaN(Date.parse(row.updatedAt))).toBe(false);
      }
    });
  }

  test('is for staff only', async ({ request }) => {
    expect((await request.get('admin/category-config')).status()).toBe(401);
    for (const account of ['customer', 'operatorAdmin'] as const) {
      await signIn(request, account);
      expect(
        (await request.get('admin/category-config')).status(),
        account,
      ).toBe(403);
    }
  });
});

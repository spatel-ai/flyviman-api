import { APIRequestContext, expect, test } from '@playwright/test';
import { AccountName } from './support/accounts.js';
import { signIn } from './support/session.js';

/**
 * Admin reports (W5-1, D-193): the role table of the eight reports and of
 * the CSV export, the finance blocks, the period rules, filters, and the
 * CSV format.
 */

const REPORTS = [
  'overview',
  'search',
  'bookings',
  'revenue',
  'payments',
  'operators',
  'empty-legs',
  'air-ambulance',
] as const;

type Report = (typeof REPORTS)[number];
type Staff = 'superAdmin' | 'ops' | 'finance';

/** Which staff role may read each report (security-rbac.md: View reports). */
const ALLOWED: Record<Report, Staff[]> = {
  overview: ['ops', 'finance', 'superAdmin'],
  search: ['ops', 'superAdmin'],
  bookings: ['ops', 'finance', 'superAdmin'],
  revenue: ['finance', 'superAdmin'],
  payments: ['finance', 'superAdmin'],
  operators: ['ops', 'superAdmin'],
  'empty-legs': ['ops', 'superAdmin'],
  'air-ambulance': ['ops', 'superAdmin'],
};

const STAFF: Staff[] = ['superAdmin', 'ops', 'finance'];

async function as(
  playwright: {
    request: { newContext(options: object): Promise<APIRequestContext> };
  },
  baseURL: string | undefined,
  account: AccountName,
) {
  const context = await playwright.request.newContext({ baseURL });
  await signIn(context, account);
  return context;
}

async function code(response: {
  json(): Promise<{ error: { code: string } }>;
}) {
  return (await response.json()).error.code;
}

test.describe('admin reports: who may read which report', () => {
  test('the role table holds for every report and its CSV export', async ({
    playwright,
    baseURL,
  }) => {
    for (const account of STAFF) {
      const context = await as(playwright, baseURL, account);
      for (const report of REPORTS) {
        const open = ALLOWED[report].includes(account);
        const json = await context.get(`admin/reports/${report}`);
        expect(json.status(), `${account} ${report}`).toBe(open ? 200 : 403);
        const csv = await context.get(`admin/reports/${report}/export`);
        expect(csv.status(), `${account} ${report} export`).toBe(
          open ? 200 : 403,
        );
        if (!open) {
          expect(await code(json)).toBe('FORBIDDEN');
          expect(await code(csv)).toBe('FORBIDDEN');
        }
      }
      await context.dispose();
    }
  });

  test('customers and operators are refused, and anonymous callers are not signed in', async ({
    request,
    playwright,
    baseURL,
  }) => {
    expect((await request.get('admin/reports/overview')).status()).toBe(401);
    expect((await request.get('admin/reports/overview/export')).status()).toBe(
      401,
    );
    for (const account of ['customer', 'operatorAdmin'] as const) {
      const context = await as(playwright, baseURL, account);
      for (const path of ['overview', 'overview/export', 'bookings']) {
        expect(
          (await context.get(`admin/reports/${path}`)).status(),
          `${account} ${path}`,
        ).toBe(403);
      }
      await context.dispose();
    }
  });
});

test.describe('admin reports: finance figures', () => {
  test('operations never see the finance blocks, finance and super administrators do', async ({
    playwright,
    baseURL,
  }) => {
    const ops = await as(playwright, baseURL, 'ops');
    const overview = (await (await ops.get('admin/reports/overview')).json())
      .data;
    expect('finance' in overview).toBe(false);
    const bookings = (await (await ops.get('admin/reports/bookings')).json())
      .data;
    expect('finance' in bookings.totals).toBe(false);
    for (const row of bookings.byCategory) {
      expect('finance' in row).toBe(false);
    }
    const csv = await (await ops.get('admin/reports/overview/export')).text();
    expect(csv).not.toMatch(/^finance,/m);

    for (const account of ['finance', 'superAdmin'] as const) {
      const context = await as(playwright, baseURL, account);
      const own = (await (await context.get('admin/reports/overview')).json())
        .data;
      expect(own.finance, account).toMatchObject({
        paymentsTaken: { count: expect.any(Number) },
        refundsDue: { count: expect.any(Number) },
      });
      expect(Array.isArray(own.finance.confirmedBookingValue)).toBe(true);
      expect(Array.isArray(own.finance.platformRevenue)).toBe(true);
      const booked = (
        await (await context.get('admin/reports/bookings')).json()
      ).data;
      expect(booked.totals.finance, account).toBeDefined();
      expect(
        (await (await context.get('admin/reports/overview/export')).text())
          .split('\r\n')
          .some((line) => line.startsWith('finance,')),
      ).toBe(true);
      await context.dispose();
    }
  });
});

test.describe('admin reports: period and filters', () => {
  test('the period defaults to the last 30 days in India, both days included', async ({
    playwright,
    baseURL,
  }) => {
    const ops = await as(playwright, baseURL, 'ops');
    const { period } = (await (await ops.get('admin/reports/overview')).json())
      .data;
    expect(period.timeZone).toBe('Asia/Kolkata');
    const days =
      (Date.parse(period.to) - Date.parse(period.from)) / 86_400_000 + 1;
    expect(days).toBe(30);
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
    }).format(new Date());
    expect(period.to).toBe(today);
  });

  test('a period with from after to, or over 366 days, is refused on every report and export', async ({
    playwright,
    baseURL,
  }) => {
    const sa = await as(playwright, baseURL, 'superAdmin');
    for (const report of REPORTS) {
      for (const suffix of ['', '/export']) {
        const backwards = await sa.get(`admin/reports/${report}${suffix}`, {
          params: { from: '2026-11-10', to: '2026-11-01' },
        });
        expect(backwards.status(), `${report}${suffix} backwards`).toBe(400);
        expect(await code(backwards)).toBe('VALIDATION_ERROR');
        const long = await sa.get(`admin/reports/${report}${suffix}`, {
          params: { from: '2025-01-01', to: '2026-11-01' },
        });
        expect(long.status(), `${report}${suffix} long`).toBe(400);
      }
    }
  });

  test('366 days is the longest period; 367 is refused', async ({
    playwright,
    baseURL,
  }) => {
    const sa = await as(playwright, baseURL, 'superAdmin');
    const ok = await sa.get('admin/reports/payments', {
      params: { from: '2025-11-01', to: '2026-11-01' },
    });
    expect(ok.status()).toBe(200);
    const over = await sa.get('admin/reports/payments', {
      params: { from: '2025-10-31', to: '2026-11-01' },
    });
    expect(over.status()).toBe(400);
  });

  test('a malformed date is refused', async ({ playwright, baseURL }) => {
    const sa = await as(playwright, baseURL, 'superAdmin');
    const response = await sa.get('admin/reports/overview', {
      params: { from: '01-11-2026' },
    });
    expect(response.status()).toBe(400);
  });

  test('a filter a report does not take is refused, one it takes is applied', async ({
    playwright,
    baseURL,
  }) => {
    const sa = await as(playwright, baseURL, 'superAdmin');
    // Reports without the category filter.
    for (const report of ['payments', 'operators', 'empty-legs', 'overview']) {
      const refused = await sa.get(`admin/reports/${report}/export`, {
        params: { category: 'PRIVATE_CHARTER' },
      });
      expect(refused.status(), `${report} category`).toBe(400);
      expect(await code(refused)).toBe('VALIDATION_ERROR');
    }
    // Reports without the operator filter.
    const operatorId = '11111111-1111-4111-8111-111111111111';
    for (const report of ['payments', 'search', 'overview', 'air-ambulance']) {
      const refused = await sa.get(`admin/reports/${report}/export`, {
        params: { operatorId },
      });
      expect(refused.status(), `${report} operatorId`).toBe(400);
    }
    // JSON routes too (their query classes whitelist the filters).
    expect(
      (
        await sa.get('admin/reports/payments', {
          params: { category: 'PRIVATE_CHARTER' },
        })
      ).status(),
    ).toBe(400);
    // Filters a report takes.
    const bookings = await sa.get('admin/reports/bookings', {
      params: { category: 'PRIVATE_CHARTER', operatorId },
    });
    expect(bookings.status()).toBe(200);
    expect((await bookings.json()).data.filters).toEqual({
      category: 'PRIVATE_CHARTER',
      operatorId,
    });
  });
});

test.describe('admin reports: CSV export', () => {
  test('is text/csv as an attachment named after the report and period, with the long-form header', async ({
    playwright,
    baseURL,
  }) => {
    const sa = await as(playwright, baseURL, 'superAdmin');
    const response = await sa.get('admin/reports/bookings/export', {
      params: { from: '2026-11-01', to: '2026-11-15' },
    });
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('text/csv');
    expect(response.headers()['content-disposition']).toBe(
      'attachment; filename="flyviman-bookings-2026-11-01-to-2026-11-15.csv"',
    );
    expect(response.headers()['cache-control']).toContain('no-store');
    expect(response.headers()['x-content-type-options']).toBe('nosniff');
    const lines = (await response.text()).split('\r\n');
    expect(lines[0]).toBe('section,dimension,metric,currency,value');
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines.slice(1).filter(Boolean)) {
      // Every row has the five columns (no value here contains a comma).
      expect(line.split(',').length, line).toBeGreaterThanOrEqual(5);
    }
  });

  test('an unknown report is 404, also for an unknown name that is an object property', async ({
    playwright,
    baseURL,
  }) => {
    const sa = await as(playwright, baseURL, 'superAdmin');
    for (const name of ['nope', 'constructor', 'toString']) {
      const response = await sa.get(`admin/reports/${name}/export`);
      expect(response.status(), name).toBe(404);
      expect(await code(response)).toBe('NOT_FOUND');
    }
  });
});

test.describe('admin reports: air ambulance carries counts only', () => {
  test('no patient, medical or contact keys appear anywhere in the report', async ({
    playwright,
    baseURL,
  }) => {
    const ops = await as(playwright, baseURL, 'ops');
    const response = await ops.get('admin/reports/air-ambulance');
    expect(response.status()).toBe(200);
    const data = (await response.json()).data;
    expect(Object.keys(data).sort()).toEqual(
      [
        'averageMinutesToConfirm',
        'averageMinutesToQuote',
        'byStatus',
        'cancelled',
        'completed',
        'confirmed',
        'declined',
        'fulfilmentRate',
        'open',
        'period',
        'quoted',
        'requests',
      ].sort(),
    );
    const keys: string[] = [];
    const walk = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (typeof value === 'object' && value !== null) {
        for (const [key, inner] of Object.entries(value)) {
          keys.push(key);
          walk(inner);
        }
      }
    };
    walk(data);
    const text = JSON.stringify(data);
    expect(text).not.toMatch(/patient|medical|condition|phone|email|contact/i);
    expect(keys.every((key) => key.length > 0)).toBe(true);
    for (const row of data.byStatus) {
      expect(Object.keys(row).sort()).toEqual(['count', 'status']);
    }
    const csv = await (
      await ops.get('admin/reports/air-ambulance/export')
    ).text();
    expect(csv).not.toMatch(/patient|medical|phone|email|contact/i);
  });
});

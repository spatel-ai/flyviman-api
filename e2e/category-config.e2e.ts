import { randomUUID } from 'node:crypto';
import { APIRequestContext, expect, test } from '@playwright/test';
import { registerCustomer } from './support/data.js';
import { withPrisma } from './support/db.js';
import { inDays, listedJet, locationId, searchFor } from './support/pricing.js';
import { csrfHeaders, signIn } from './support/session.js';

interface Row {
  category: string;
  region: string;
  isEnabled: boolean;
  bookingMode: string;
  paymentModel: string;
  depositPercent: number;
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
          'id',
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

async function rowOf(request: APIRequestContext, category: string) {
  const response = await request.get('admin/category-config');
  expect(response.status()).toBe(200);
  const rows = (await response.json()).data as (Row & { id: string })[];
  return rows.find((row) => row.region === 'IN' && row.category === category)!;
}

async function patch(
  request: APIRequestContext,
  id: string,
  data: Record<string, unknown>,
) {
  return request.patch(`admin/category-config/${id}`, {
    headers: await csrfHeaders(request),
    data,
  });
}

/** Puts a row back as the seed has it, whatever a failed test left. */
async function restore(
  request: APIRequestContext,
  category: string,
  defaults: Partial<Row>,
) {
  await signIn(request, 'superAdmin');
  const row = await rowOf(request, category);
  const change = Object.fromEntries(
    Object.entries(defaults).filter(
      ([key, value]) => row[key as keyof Row] !== value,
    ),
  );
  if (Object.keys(change).length === 0) return;
  const response = await patch(request, row.id, {
    ...change,
    expectedUpdatedAt: row.updatedAt,
    reason: 'Test clean-up',
  });
  expect(response.status()).toBe(200);
}

// These change platform rows other files read, so they run one after the
// other and put every row back in afterAll.
test.describe.serial('PATCH /admin/category-config/:id', () => {
  test.afterAll(async ({ playwright, baseURL }) => {
    const request = await playwright.request.newContext({ baseURL });
    await restore(request, 'HELICOPTER', { isEnabled: true });
    await restore(request, 'PRIVATE_CHARTER', { depositPercent: 25 });
    await request.dispose();
  });

  test('only a super administrator may change a row; operations and finance may only read', async ({
    request,
    playwright,
    baseURL,
  }) => {
    await signIn(request, 'superAdmin');
    const row = await rowOf(request, 'HELICOPTER');
    const body = {
      isEnabled: true,
      expectedUpdatedAt: row.updatedAt,
      reason: 'Role check',
    };
    const anonymous = await playwright.request.newContext({ baseURL });
    expect(
      (
        await anonymous.patch(`admin/category-config/${row.id}`, { data: body })
      ).status(),
    ).toBe(401);
    for (const account of [
      'ops',
      'finance',
      'customer',
      'operatorAdmin',
    ] as const) {
      const context = await playwright.request.newContext({ baseURL });
      await signIn(context, account);
      expect((await patch(context, row.id, body)).status(), account).toBe(403);
    }
    const unchanged = await rowOf(request, 'HELICOPTER');
    expect(unchanged.updatedAt).toBe(row.updatedAt);
  });

  test('a reason and the version being edited are required, and a bad value is refused', async ({
    request,
  }) => {
    await signIn(request, 'superAdmin');
    const row = await rowOf(request, 'HELICOPTER');
    const ok = {
      isEnabled: true,
      expectedUpdatedAt: row.updatedAt,
      reason: 'Check',
    };
    const { reason: _reason, ...noReason } = ok;
    const { expectedUpdatedAt: _version, ...noVersion } = ok;
    for (const [name, data] of Object.entries({
      'no reason': noReason,
      'a blank reason': { ...ok, reason: '  ' },
      'no expectedUpdatedAt': noVersion,
      'a null field': { ...ok, isEnabled: null },
      'a deposit over 100': { ...ok, depositPercent: 101 },
      'a deposit of 0': { ...ok, depositPercent: 0 },
      'an unknown payment model': { ...ok, paymentModel: 'D' },
    })) {
      const response = await patch(request, row.id, data);
      expect(response.status(), name).toBe(400);
      expect((await response.json()).error.code, name).toBe('VALIDATION_ERROR');
    }
    expect((await rowOf(request, 'HELICOPTER')).updatedAt).toBe(row.updatedAt);
    const missing = await patch(request, randomUUID(), ok);
    expect(missing.status()).toBe(404);
  });

  test('a stale version is 409 CATEGORY_CONFIG_CHANGED with the current version, and writes nothing', async ({
    request,
  }) => {
    await signIn(request, 'superAdmin');
    const row = await rowOf(request, 'PRIVATE_CHARTER');
    const first = await patch(request, row.id, {
      depositPercent: 30,
      expectedUpdatedAt: row.updatedAt,
      reason: 'First editor',
    });
    expect(first.status()).toBe(200);
    const current = (await first.json()).data;
    expect(current.depositPercent).toBe(30);
    const stale = await patch(request, row.id, {
      depositPercent: 35,
      expectedUpdatedAt: row.updatedAt,
      reason: 'Second editor, stale',
    });
    expect(stale.status()).toBe(409);
    const error = (await stale.json()).error;
    expect(error.code).toBe('CATEGORY_CONFIG_CHANGED');
    expect(error.details).toEqual([
      { field: 'expectedUpdatedAt', issue: current.updatedAt },
    ]);
    expect((await rowOf(request, 'PRIVATE_CHARTER')).depositPercent).toBe(30);
  });

  test('air ambulance can never be INSTANT (rule 7): 422 CATEGORY_CONFIG_INVALID', async ({
    request,
  }) => {
    await signIn(request, 'superAdmin');
    const row = await rowOf(request, 'AIR_AMBULANCE');
    const response = await patch(request, row.id, {
      bookingMode: 'INSTANT',
      expectedUpdatedAt: row.updatedAt,
      reason: 'Should be refused',
    });
    expect(response.status()).toBe(422);
    expect((await response.json()).error.code).toBe('CATEGORY_CONFIG_INVALID');
    const after = await rowOf(request, 'AIR_AMBULANCE');
    expect(after.bookingMode).toBe('REQUEST');
    expect(after.updatedAt).toBe(row.updatedAt);
  });

  test('the change is audited with the reason, before and after, and a no-op writes nothing', async ({
    request,
  }) => {
    await signIn(request, 'superAdmin');
    const row = await rowOf(request, 'PRIVATE_CHARTER');
    const target = row.depositPercent === 40 ? 45 : 40;
    const reason = 'Audit check';
    const response = await patch(request, row.id, {
      depositPercent: target,
      expectedUpdatedAt: row.updatedAt,
      reason,
    });
    expect(response.status()).toBe(200);
    const updated = (await response.json()).data;
    const audits = () =>
      withPrisma((prisma) =>
        prisma.auditLog.findMany({
          where: { entityId: row.id, action: 'category_config.update' },
          orderBy: { createdAt: 'desc' },
        }),
      );
    const [latest] = await audits();
    expect(latest.reason).toBe(reason);
    expect(latest.actorRole).toBe('SUPER_ADMIN');
    expect(latest.before).toMatchObject({ depositPercent: row.depositPercent });
    expect(latest.after).toMatchObject({ depositPercent: target });
    const count = (await audits()).length;

    const same = await patch(request, row.id, {
      depositPercent: target,
      expectedUpdatedAt: updated.updatedAt,
      reason: 'Same values',
    });
    expect(same.status()).toBe(200);
    expect((await same.json()).data.updatedAt).toBe(updated.updatedAt);
    expect((await audits()).length).toBe(count);
  });

  test('a disabled category answers 422 CATEGORY_DISABLED on search and calendar, and re-enabling restores it', async ({
    request,
  }) => {
    await signIn(request, 'superAdmin');
    const row = await rowOf(request, 'HELICOPTER');
    const originId = await locationId(request, 'BOM');
    const destinationId = await locationId(request, 'GOI');
    const search = async () =>
      request.post('search/helicopter', {
        headers: await csrfHeaders(request),
        data: {
          originId,
          destinationId,
          departureAt: inDays(4).toISOString(),
          passengerCount: 2,
        },
      });
    const calendar = () =>
      request.get('search/calendar', {
        params: {
          category: 'HELICOPTER',
          originId,
          destinationId,
          month: inDays(30).toISOString().slice(0, 7),
          passengerCount: 2,
        },
      });
    expect((await search()).status()).toBe(200);
    expect((await calendar()).status()).toBe(200);

    const off = await patch(request, row.id, {
      isEnabled: false,
      expectedUpdatedAt: row.updatedAt,
      reason: 'Disable helicopters for a test',
    });
    expect(off.status()).toBe(200);
    try {
      for (const response of [await search(), await calendar()]) {
        expect(response.status()).toBe(422);
        expect((await response.json()).error.code).toBe('CATEGORY_DISABLED');
      }
      // Other categories are unaffected.
      const charter = await request.get('search/calendar', {
        params: {
          category: 'PRIVATE_CHARTER',
          originId,
          destinationId,
          month: inDays(30).toISOString().slice(0, 7),
          passengerCount: 2,
        },
      });
      expect(charter.status()).toBe(200);
    } finally {
      const disabled = await rowOf(request, 'HELICOPTER');
      const on = await patch(request, row.id, {
        isEnabled: true,
        expectedUpdatedAt: disabled.updatedAt,
        reason: 'Enable helicopters again',
      });
      expect(on.status()).toBe(200);
    }
    expect((await search()).status()).toBe(200);
    expect((await calendar()).status()).toBe(200);
  });

  test('a Model C booking keeps the deposit percent saved at creation when the configuration changes (D-209)', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const trip = await listedJet(contexts);
    const rate = await request.put(
      `operator/aircraft/${trip.aircraftId}/pricing`,
      {
        headers: await csrfHeaders(request),
        data: {
          hourlyRateMinor: 18_000_000,
          taxInclusive: false,
          commissionInclusive: false,
          minBillableHours: null,
        },
      },
    );
    expect(rate.status()).toBe(200);
    const operatorId = (await (await request.get('operator/profile')).json())
      .data.id as string;
    await withPrisma((prisma) =>
      prisma.operator.update({
        where: { id: operatorId },
        data: { paymentModel: { PRIVATE_CHARTER: 'C_DEPOSIT' } },
      }),
    );

    const admin = await playwright.request.newContext({ baseURL });
    await signIn(admin, 'superAdmin');
    const row = await rowOf(admin, 'PRIVATE_CHARTER');
    const saved = row.depositPercent;
    const searched = await searchFor(request, trip);
    const customer = await playwright.request.newContext({ baseURL });
    await registerCustomer(customer);
    const booked = await customer.post('bookings', {
      headers: {
        ...(await csrfHeaders(customer)),
        'Idempotency-Key': randomUUID(),
      },
      data: {
        searchId: searched.searchId,
        resultId: searched.result.resultId,
        cancellationTermsVersion: searched.termsVersion,
        expectedTotalMinor: searched.result.price.amountMinor,
        currency: 'INR',
      },
    });
    expect(booked.status()).toBe(201);
    const reference = (await booked.json()).data.reference as string;
    const total = searched.result.price.amountMinor as number;
    await withPrisma((prisma) =>
      prisma.booking.update({
        where: { reference },
        data: {
          status: 'AWAITING_PAYMENT',
          priceType: 'CONFIRMED',
          operatorAcceptedAt: new Date(),
        },
      }),
    );
    const read = () =>
      withPrisma((prisma) =>
        prisma.booking.findUniqueOrThrow({ where: { reference } }),
      );
    expect(await read()).toMatchObject({
      paymentModel: 'C_DEPOSIT',
      depositPercent: saved,
    });

    const target = saved === 50 ? 60 : 50;
    const changed = await patch(admin, row.id, {
      depositPercent: target,
      expectedUpdatedAt: row.updatedAt,
      reason: 'Raise the deposit',
    });
    expect(changed.status()).toBe(200);

    expect((await read()).depositPercent).toBe(saved);
    const detail = await customer.get(`bookings/${reference}`);
    expect((await detail.json()).data.amountDue).toMatchObject({
      amountMinor: Math.ceil((total * saved) / 100),
    });
  });
});

import { randomUUID } from 'node:crypto';
import { APIRequestContext, expect, test } from '@playwright/test';
import {
  latestLinkToken,
  PASSWORD,
  registerCustomer,
  registerOperator,
  uniqueEmail,
  uploadPdf,
} from './support/data.js';
import { withPrisma } from './support/db.js';
import { approvedOperator } from './support/fleet.js';
import { AccountName } from './support/accounts.js';
import { csrfHeaders, signIn } from './support/session.js';

/** Air ambulance requests and the operations queue (M11, W4-4 and W4-5). */

type Playwright = {
  request: { newContext(options: object): Promise<APIRequestContext> };
};

const CONDITION = 'Post-operative cardiac patient, stable on monitoring';
const ALL_CHECKED = {
  operatorAcceptance: true,
  aircraft: true,
  crew: true,
  medicalTeam: true,
  medicalSuitability: true,
  equipment: true,
  landingPermissions: true,
  clearances: true,
  weather: true,
};

async function locationIds(request: APIRequestContext): Promise<string[]> {
  const response = await request.get('locations', { params: { pageSize: 2 } });
  expect(response.status()).toBe(200);
  return ((await response.json()).data as { id: string }[]).map((l) => l.id);
}

async function requestBody(request: APIRequestContext) {
  const [origin, destination] = await locationIds(request);
  return {
    contactName: 'Asha Rao',
    contactPhone: '+919800000001',
    contactEmail: 'asha@example.com',
    originLocationId: origin,
    destinationLocationId: destination,
    pickupAddress: 'City Hospital, Ward 4',
    preferredAt: new Date(Date.now() + 86_400_000).toISOString(),
    patientCount: 1,
    accompanyingPersons: 1,
    medical: {
      patientCondition: CONDITION,
      mobility: 'NON_AMBULATORY',
      stretcherRequired: true,
      oxygenRequired: true,
      medicalStaffRequired: 'ICU doctor and nurse',
    },
  };
}

async function submit(
  request: APIRequestContext,
  key = randomUUID(),
  body?: Awaited<ReturnType<typeof requestBody>>,
) {
  return request.post('air-ambulance/requests', {
    headers: { ...(await csrfHeaders(request)), 'Idempotency-Key': key },
    data: body ?? (await requestBody(request)),
  });
}

/** A fresh customer on its own context, with one submitted request. */
async function customerWithRequest(playwright: Playwright, baseURL?: string) {
  const customer = await playwright.request.newContext({ baseURL });
  const { id } = await registerCustomer(customer);
  const created = await submit(customer);
  expect(created.status()).toBe(201);
  const reference = (await created.json()).data.reference as string;
  return { customer, customerId: id, reference };
}

async function as(
  playwright: Playwright,
  baseURL: string | undefined,
  account: AccountName,
) {
  const context = await playwright.request.newContext({ baseURL });
  await signIn(context, account);
  return context;
}

async function userId(context: APIRequestContext): Promise<string> {
  return (await (await context.get('me')).json()).data.id as string;
}

/** Medical read audit entries for a request, by reference. */
async function medicalReads(reference: string) {
  return withPrisma(async (prisma) => {
    const row = await prisma.airAmbulanceRequest.findUniqueOrThrow({
      where: { reference },
      select: { id: true },
    });
    return prisma.auditLog.findMany({
      where: { entityId: row.id, action: 'air_ambulance_request.medical_read' },
      select: { actorRole: true, before: true, after: true, reason: true },
    });
  });
}

/** Invites an internal user and signs them in on a context of their own. */
async function newStaff(
  playwright: Playwright,
  baseURL: string | undefined,
  role: 'OPS',
) {
  const admin = await as(playwright, baseURL, 'superAdmin');
  const email = uniqueEmail('ops');
  expect(
    (
      await admin.post('admin/staff', {
        headers: await csrfHeaders(admin),
        data: { email, role },
      })
    ).status(),
  ).toBe(201);
  const staff = await playwright.request.newContext({ baseURL });
  const token = await latestLinkToken(staff, email);
  expect(
    (
      await staff.post('auth/password/reset', {
        data: { token, password: PASSWORD },
      })
    ).status(),
  ).toBe(204);
  expect(
    (
      await staff.post('auth/login', { data: { email, password: PASSWORD } })
    ).status(),
  ).toBe(200);
  await admin.dispose();
  return staff;
}

test.describe('POST /air-ambulance/requests', () => {
  test('records a SUBMITTED request with the emergency notice and nothing personal in the answer', async ({
    request,
  }) => {
    await registerCustomer(request);
    const key = randomUUID();
    const body = await requestBody(request);
    const created = await submit(request, key, body);
    expect(created.status()).toBe(201);
    const data = (await created.json()).data;
    expect(data).toEqual({
      reference: expect.stringMatching(/^FLY-AA-[2-9A-Z]{6}$/),
      status: 'SUBMITTED',
      emergencyNotice: expect.stringContaining('112'),
      createdAt: expect.any(String),
    });

    // A repeat with the same key and body returns the first answer.
    const again = await submit(request, key, body);
    expect(again.status()).toBe(201);
    expect((await again.json()).data.reference).toBe(data.reference);

    // The medical text is stored encrypted, never in the clear.
    const stored = await withPrisma((prisma) =>
      prisma.airAmbulanceMedical.findFirstOrThrow({
        where: { request: { reference: data.reference } },
      }),
    );
    expect(stored.patientCondition).not.toContain('cardiac');
    const place = await withPrisma((prisma) =>
      prisma.airAmbulanceRequest.findUniqueOrThrow({
        where: { reference: data.reference },
        select: { pickupAddress: true },
      }),
    );
    expect(place.pickupAddress).not.toContain('Hospital');
  });

  test('needs an Idempotency-Key', async ({ request }) => {
    await registerCustomer(request);
    const response = await request.post('air-ambulance/requests', {
      headers: await csrfHeaders(request),
      data: await requestBody(request),
    });
    expect(response.status()).toBe(400);
  });

  test('validates the locations: 400 for the same place, 404 for an unknown one', async ({
    request,
  }) => {
    await registerCustomer(request);
    const body = await requestBody(request);
    const headers = await csrfHeaders(request);
    const same = await request.post('air-ambulance/requests', {
      headers: { ...headers, 'Idempotency-Key': randomUUID() },
      data: { ...body, destinationLocationId: body.originLocationId },
    });
    expect(same.status()).toBe(400);
    const unknown = await request.post('air-ambulance/requests', {
      headers: { ...headers, 'Idempotency-Key': randomUUID() },
      data: { ...body, originLocationId: randomUUID() },
    });
    expect(unknown.status()).toBe(404);
    expect((await unknown.json()).error.details).toEqual([
      { field: 'originLocationId', issue: 'no active location with this id' },
    ]);
    const invalid = await request.post('air-ambulance/requests', {
      headers: { ...headers, 'Idempotency-Key': randomUUID() },
      data: { ...body, medical: { mobility: 'FLYING' } },
    });
    expect(invalid.status()).toBe(400);
  });

  test('is for customers only', async ({ request }) => {
    await signIn(request, 'finance');
    expect((await submit(request)).status()).toBe(403);
    await signIn(request, 'ops');
    expect((await submit(request)).status()).toBe(403);
  });
});

test.describe('GET /air-ambulance/requests', () => {
  test('the requester reads their request with medical details, audited; others get 404', async ({
    playwright,
    baseURL,
  }) => {
    const { customer, reference } = await customerWithRequest(
      playwright,
      baseURL,
    );
    const list = await customer.get('air-ambulance/requests');
    expect(list.status()).toBe(200);
    const listed = await list.json();
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0]).toMatchObject({
      reference,
      status: 'SUBMITTED',
      price: null,
      emergencyNotice: expect.stringContaining('112'),
    });
    expect(JSON.stringify(listed)).not.toMatch(/cardiac|Asha|\+91/);

    const detail = await customer.get(`air-ambulance/requests/${reference}`);
    expect(detail.status()).toBe(200);
    const data = (await detail.json()).data;
    expect(data).toMatchObject({
      reference,
      status: 'SUBMITTED',
      contactName: 'Asha Rao',
      pickupAddress: 'City Hospital, Ward 4',
      quote: null,
      confirmedAt: null,
      medical: {
        patientCondition: CONDITION,
        mobility: 'NON_AMBULATORY',
        medicalStaffRequired: 'ICU doctor and nurse',
        documents: [],
      },
      timeline: [{ status: 'SUBMITTED' }],
      emergencyNotice: expect.stringContaining('112'),
    });
    const reads = await medicalReads(reference);
    expect(reads).toHaveLength(1);
    expect(reads[0].actorRole).toBe('CUSTOMER');
    expect(JSON.stringify(reads)).not.toMatch(/cardiac|ICU/);

    // Another customer: not found, and not in their list.
    const other = await playwright.request.newContext({ baseURL });
    await registerCustomer(other);
    expect(
      (await other.get(`air-ambulance/requests/${reference}`)).status(),
    ).toBe(404);
    expect(
      (await (await other.get('air-ambulance/requests')).json()).data,
    ).toEqual([]);
    expect(
      (await other.get('air-ambulance/requests/not-a-reference')).status(),
    ).toBe(404);

    // Finance and operator roles cannot use the customer routes.
    for (const account of ['finance', 'operatorAdmin'] as const) {
      const staff = await as(playwright, baseURL, account);
      expect(
        (await staff.get(`air-ambulance/requests/${reference}`)).status(),
      ).toBe(403);
      await staff.dispose();
    }
    await other.dispose();
    await customer.dispose();
  });
});

test.describe('air ambulance medical documents', () => {
  test('upload, attach and download only by those who may read medical details, audited', async ({
    playwright,
    baseURL,
  }) => {
    const { customer, reference } = await customerWithRequest(
      playwright,
      baseURL,
    );
    const headers = await csrfHeaders(customer);
    const fileId = await uploadPdf(
      customer,
      headers,
      'discharge-summary.pdf',
      'AIR_AMBULANCE_DOCUMENT',
    );
    const attached = await customer.post(
      `air-ambulance/requests/${reference}/documents`,
      { headers, data: { fileId } },
    );
    expect(attached.status()).toBe(201);
    expect((await attached.json()).data).toMatchObject({
      fileId,
      fileName: 'discharge-summary.pdf',
    });
    const detail = (
      await (await customer.get(`air-ambulance/requests/${reference}`)).json()
    ).data;
    expect(detail.medical.documents).toEqual([
      expect.objectContaining({ fileId, fileName: 'discharge-summary.pdf' }),
    ]);

    // The same file cannot be attached twice; another's file not at all.
    const twice = await customer.post(
      `air-ambulance/requests/${reference}/documents`,
      { headers, data: { fileId } },
    );
    expect(twice.status()).toBe(422);

    const before = (await medicalReads(reference)).length;
    expect((await customer.get(`documents/${fileId}/download`)).status()).toBe(
      200,
    );
    expect(await medicalReads(reference)).toHaveLength(before + 1);

    // Another customer, finance, operator admin and unassigned operations: 404.
    const other = await playwright.request.newContext({ baseURL });
    await registerCustomer(other);
    expect((await other.get(`documents/${fileId}/download`)).status()).toBe(
      404,
    );
    const otherFile = await uploadPdf(
      other,
      await csrfHeaders(other),
      'x.pdf',
      'AIR_AMBULANCE_DOCUMENT',
    );
    expect(
      (
        await other.post(`air-ambulance/requests/${reference}/documents`, {
          headers: await csrfHeaders(other),
          data: { fileId: otherFile },
        })
      ).status(),
    ).toBe(404);
    expect(
      (
        await customer.post(`air-ambulance/requests/${reference}/documents`, {
          headers,
          data: { fileId: otherFile },
        })
      ).status(),
    ).toBe(422);
    for (const account of ['finance', 'operatorAdmin', 'ops'] as const) {
      const staff = await as(playwright, baseURL, account);
      expect(
        (await staff.get(`documents/${fileId}/download`)).status(),
        account,
      ).toBe(404);
      await staff.dispose();
    }
    expect(await medicalReads(reference)).toHaveLength(before + 1);

    // Once operations own it, the owner may download; so may the super admin.
    const ops = await as(playwright, baseURL, 'ops');
    const assign = await ops.post(
      `admin/air-ambulance/requests/${reference}/assign`,
      { headers: await csrfHeaders(ops), data: {} },
    );
    expect(assign.status()).toBe(200);
    expect((await ops.get(`documents/${fileId}/download`)).status()).toBe(200);
    const admin = await as(playwright, baseURL, 'superAdmin');
    expect((await admin.get(`documents/${fileId}/download`)).status()).toBe(
      200,
    );
    expect(await medicalReads(reference)).toHaveLength(before + 3);

    // Only customers reserve medical uploads.
    const operator = await as(playwright, baseURL, 'operatorAdmin');
    const presign = await operator.post('uploads/presign', {
      headers: await csrfHeaders(operator),
      data: {
        purpose: 'AIR_AMBULANCE_DOCUMENT',
        fileName: 'a.pdf',
        contentType: 'application/pdf',
        sizeBytes: 100,
      },
    });
    expect(presign.status()).toBe(403);

    for (const context of [customer, other, ops, admin, operator]) {
      await context.dispose();
    }
  });
});

test.describe('operations queue', () => {
  test('unassigned operations see the request without medical details and cannot act on it', async ({
    playwright,
    baseURL,
  }) => {
    const { customer, reference } = await customerWithRequest(
      playwright,
      baseURL,
    );
    const ops = await as(playwright, baseURL, 'ops');
    const second = await newStaff(playwright, baseURL, 'OPS');

    const unassigned = await ops.get('admin/air-ambulance/requests', {
      params: { assignee: 'none', status: 'SUBMITTED', pageSize: 100 },
    });
    expect(unassigned.status()).toBe(200);
    const rows = (await unassigned.json()).data as { reference: string }[];
    expect(rows.map((r) => r.reference)).toContain(reference);
    expect(JSON.stringify(rows)).not.toMatch(/cardiac|Asha/);

    const view = await ops.get(`admin/air-ambulance/requests/${reference}`);
    expect(view.status()).toBe(200);
    expect((await view.json()).data).toMatchObject({
      reference,
      medical: null,
      pickupAddress: null,
      destinationFacility: null,
      assignedToId: null,
      feasibility: null,
    });
    expect(await medicalReads(reference)).toHaveLength(0);

    // The second operations user takes it; the first may no longer act.
    const take = await second.post(
      `admin/air-ambulance/requests/${reference}/assign`,
      { headers: await csrfHeaders(second), data: {} },
    );
    expect(take.status()).toBe(200);
    expect((await take.json()).data).toMatchObject({
      status: 'ASSIGNED',
      assignedToId: await userId(second),
    });
    const mine = (
      await (
        await second.get('admin/air-ambulance/requests', {
          params: { assignee: 'me' },
        })
      ).json()
    ).data as { reference: string }[];
    expect(mine.map((r) => r.reference)).toEqual([reference]);

    const opsHeaders = await csrfHeaders(ops);
    expect(
      (
        await ops.patch(`admin/air-ambulance/requests/${reference}/status`, {
          headers: opsHeaders,
          data: { status: 'SOURCING' },
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await ops.post(`admin/air-ambulance/requests/${reference}/assign`, {
          headers: opsHeaders,
          data: {},
        })
      ).status(),
    ).toBe(403);
    const opsView = await ops.get(`admin/air-ambulance/requests/${reference}`);
    expect((await opsView.json()).data.medical).toBeNull();

    // The owner reads the medical details, audited.
    const ownerView = (
      await (
        await second.get(`admin/air-ambulance/requests/${reference}`)
      ).json()
    ).data;
    expect(ownerView.medical.patientCondition).toBe(CONDITION);
    expect(await medicalReads(reference)).toHaveLength(1);

    // An owner must be active operations staff.
    const invalid = await second.post(
      `admin/air-ambulance/requests/${reference}/assign`,
      {
        headers: await csrfHeaders(second),
        data: { assigneeId: randomUUID() },
      },
    );
    expect(invalid.status()).toBe(422);

    for (const context of [customer, ops, second]) await context.dispose();
  });

  test('finance, operator staff and customers are refused the queue', async ({
    playwright,
    baseURL,
    request,
  }) => {
    const { customer, reference } = await customerWithRequest(
      playwright,
      baseURL,
    );
    await approvedOperator(request, playwright, baseURL);
    const email = uniqueEmail('staff');
    expect(
      (
        await request.post('operator/staff', {
          headers: await csrfHeaders(request),
          data: {
            email,
            allAircraft: true,
            aircraftIds: [],
            capabilities: ['MANAGE_AIRCRAFT'],
          },
        })
      ).status(),
    ).toBe(201);
    const staff = await playwright.request.newContext({ baseURL });
    const token = await latestLinkToken(staff, email);
    await staff.post('auth/password/reset', {
      data: { token, password: PASSWORD },
    });
    expect(
      (
        await staff.post('auth/login', { data: { email, password: PASSWORD } })
      ).status(),
    ).toBe(200);
    const finance = await as(playwright, baseURL, 'finance');
    const fileId = await uploadPdf(
      customer,
      await csrfHeaders(customer),
      'report.pdf',
      'AIR_AMBULANCE_DOCUMENT',
    );
    expect(
      (
        await customer.post(`air-ambulance/requests/${reference}/documents`, {
          headers: await csrfHeaders(customer),
          data: { fileId },
        })
      ).status(),
    ).toBe(201);
    for (const context of [staff, request, finance]) {
      expect((await context.get(`documents/${fileId}/download`)).status()).toBe(
        404,
      );
    }

    for (const [name, context] of [
      ['finance', finance],
      ['operator staff', staff],
      ['operator admin', request],
      ['customer', customer],
    ] as const) {
      expect(
        (await context.get('admin/air-ambulance/requests')).status(),
        name,
      ).toBe(403);
      expect(
        (
          await context.get(`admin/air-ambulance/requests/${reference}`)
        ).status(),
        name,
      ).toBe(403);
      expect(
        (
          await context.post(
            `admin/air-ambulance/requests/${reference}/assign`,
            { headers: await csrfHeaders(context), data: {} },
          )
        ).status(),
        name,
      ).toBe(403);
    }
    expect(
      (await staff.get(`air-ambulance/requests/${reference}`)).status(),
    ).toBe(403);
    for (const context of [customer, staff, finance]) await context.dispose();
  });

  test('the whole workflow: quotation, acceptance, and confirmation only with the checklist complete', async ({
    playwright,
    baseURL,
    request,
  }) => {
    // An approved operator (on `request`) and one still in draft.
    await approvedOperator(request, playwright, baseURL);
    const operatorId = (await (await request.get('operator/profile')).json())
      .data.id as string;
    const draft = await playwright.request.newContext({ baseURL });
    await registerOperator(draft);
    const draftId = (await (await draft.get('operator/profile')).json()).data
      .id as string;

    const { customer, reference } = await customerWithRequest(
      playwright,
      baseURL,
    );
    const fileId = await uploadPdf(
      customer,
      await csrfHeaders(customer),
      'report.pdf',
      'AIR_AMBULANCE_DOCUMENT',
    );
    expect(
      (
        await customer.post(`air-ambulance/requests/${reference}/documents`, {
          headers: await csrfHeaders(customer),
          data: { fileId },
        })
      ).status(),
    ).toBe(201);
    const ops = await newStaff(playwright, baseURL, 'OPS');
    const headers = await csrfHeaders(ops);
    const path = `admin/air-ambulance/requests/${reference}`;
    const move = (status: string) =>
      ops.patch(`${path}/status`, { headers, data: { status } });

    expect(
      (await ops.post(`${path}/assign`, { headers, data: {} })).status(),
    ).toBe(200);
    // Skipping a step is refused.
    expect((await move('FEASIBILITY_CHECK')).status()).toBe(409);
    expect((await move('SOURCING')).status()).toBe(200);
    // The checklist waits for the feasibility step; quoting too.
    expect(
      (
        await ops.put(`${path}/feasibility`, { headers, data: ALL_CHECKED })
      ).status(),
    ).toBe(409);
    expect((await move('FEASIBILITY_CHECK')).status()).toBe(200);
    expect(
      (
        await ops.put(`${path}/feasibility`, {
          headers,
          data: { ...ALL_CHECKED, weather: false, landingPermissions: false },
        })
      ).status(),
    ).toBe(200);

    const quote = (id: string, amountMinor = 45_000_000) =>
      ops.post(`${path}/quote`, {
        headers,
        data: {
          operatorId: id,
          amountMinor,
          currency: 'INR',
          conditions: 'Free cancellation until the aircraft is dispatched.',
        },
      });
    expect((await quote(draftId)).status()).toBe(409);
    expect((await quote(randomUUID())).status()).toBe(404);
    const quoted = await quote(operatorId);
    expect(quoted.status()).toBe(200);
    expect((await quoted.json()).data).toMatchObject({
      status: 'QUOTED',
      price: { priceType: 'QUOTE', amountMinor: 45_000_000, currency: 'INR' },
    });
    // A revised quotation replaces the last one.
    expect((await quote(operatorId, 48_000_000)).status()).toBe(200);

    // The customer sees a labelled quotation with its conditions.
    const seen = (
      await (await customer.get(`air-ambulance/requests/${reference}`)).json()
    ).data;
    expect(seen.status).toBe('QUOTED');
    expect(seen.quote).toMatchObject({
      price: { priceType: 'QUOTE', amountMinor: 48_000_000, currency: 'INR' },
      conditions: 'Free cancellation until the aircraft is dispatched.',
      operatorName: expect.any(String),
    });

    // The selected operator's administrator reads nothing medical yet.
    expect((await request.get(`documents/${fileId}/download`)).status()).toBe(
      404,
    );

    // Operations cannot confirm before acceptance.
    expect((await move('CONFIRMED')).status()).toBe(409);

    const customerHeaders = await csrfHeaders(customer);
    const stale = await customer.post(
      `air-ambulance/requests/${reference}/quote/accept`,
      { headers: customerHeaders, data: { expectedAmountMinor: 45_000_000 } },
    );
    expect(stale.status()).toBe(409);
    expect((await stale.json()).error.code).toBe('AIR_AMBULANCE_QUOTE_CHANGED');
    const accepted = await customer.post(
      `air-ambulance/requests/${reference}/quote/accept`,
      { headers: customerHeaders, data: { expectedAmountMinor: 48_000_000 } },
    );
    expect(accepted.status()).toBe(200);
    expect((await accepted.json()).data.status).toBe('ACCEPTED');
    // From acceptance, the selected operator's administrator may (audited).
    expect((await request.get(`documents/${fileId}/download`)).status()).toBe(
      200,
    );

    // Confirmation without the whole checklist is refused, and changes nothing.
    const refused = await move('CONFIRMED');
    expect(refused.status()).toBe(422);
    const error = (await refused.json()).error;
    expect(error.code).toBe('AIR_AMBULANCE_FEASIBILITY_INCOMPLETE');
    expect(error.details.map((d: { field: string }) => d.field).sort()).toEqual(
      ['landingPermissions', 'weather'],
    );
    expect((await (await ops.get(path)).json()).data).toMatchObject({
      status: 'ACCEPTED',
      confirmedAt: null,
    });

    expect(
      (
        await ops.put(`${path}/feasibility`, { headers, data: ALL_CHECKED })
      ).status(),
    ).toBe(200);
    expect((await move('CONFIRMED')).status()).toBe(200);
    expect((await move('COMPLETED')).status()).toBe(200);
    expect((await move('CANCELLED')).status()).toBe(409);

    const final = (await (await ops.get(path)).json()).data;
    expect(final).toMatchObject({
      status: 'COMPLETED',
      confirmedAt: expect.any(String),
      completedAt: expect.any(String),
      selectedOperatorId: operatorId,
      feasibility: { ...ALL_CHECKED, complete: true },
    });
    expect(final.events.map((e: { toStatus: string }) => e.toStatus)).toEqual([
      'SUBMITTED',
      'ASSIGNED',
      'SOURCING',
      'FEASIBILITY_CHECK',
      'FEASIBILITY_CHECK',
      'QUOTED',
      'QUOTED',
      'ACCEPTED',
      'ACCEPTED',
      'CONFIRMED',
      'COMPLETED',
    ]);
    const confirmed = final.events.find(
      (e: { toStatus: string }) => e.toStatus === 'CONFIRMED',
    );
    expect(confirmed.actorRole).toBe('OPS');

    // The customer's timeline shows status changes only.
    const timeline = (
      await (await customer.get(`air-ambulance/requests/${reference}`)).json()
    ).data.timeline.map((e: { status: string }) => e.status);
    expect(timeline).toEqual([
      'SUBMITTED',
      'ASSIGNED',
      'SOURCING',
      'FEASIBILITY_CHECK',
      'QUOTED',
      'ACCEPTED',
      'CONFIRMED',
      'COMPLETED',
    ]);

    // Every step is audited, without medical or contact data (rule 8).
    const audit = await withPrisma(async (prisma) => {
      const row = await prisma.airAmbulanceRequest.findUniqueOrThrow({
        where: { reference },
        select: { id: true },
      });
      return prisma.auditLog.findMany({
        where: { entityId: row.id },
        select: { action: true, before: true, after: true, reason: true },
      });
    });
    const actions = audit.map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'air_ambulance_request.create',
        'air_ambulance_request.transition',
        'air_ambulance_request.feasibility',
        'air_ambulance_request.quote',
      ]),
    );
    expect(JSON.stringify(audit)).not.toMatch(/cardiac|ICU|Asha|\+91|Hospital/);

    // A suspended operator's administrator loses access at once.
    expect((await request.get(`documents/${fileId}/download`)).status()).toBe(
      200,
    );
    const suspended = await ops.post(`admin/operators/${operatorId}/suspend`, {
      headers,
      data: { reason: 'Insurance lapsed.' },
    });
    expect(suspended.status()).toBe(200);
    expect((await request.get(`documents/${fileId}/download`)).status()).toBe(
      404,
    );

    for (const context of [draft, customer, ops]) await context.dispose();
  });

  test('the customer declines a quotation or withdraws; closed requests do not move', async ({
    playwright,
    baseURL,
  }) => {
    const { customer, reference } = await customerWithRequest(
      playwright,
      baseURL,
    );
    const headers = await csrfHeaders(customer);
    const base = `air-ambulance/requests/${reference}`;
    // Nothing to decline or accept yet.
    expect(
      (await customer.post(`${base}/quote/decline`, { headers })).status(),
    ).toBe(409);
    expect(
      (
        await customer.post(`${base}/quote/accept`, {
          headers,
          data: { expectedAmountMinor: 1 },
        })
      ).status(),
    ).toBe(409);

    // A quotation (set up directly: quoting needs an approved operator,
    // covered by the workflow test) can be declined.
    const declinable = await customerWithRequest(playwright, baseURL);
    await withPrisma(async (prisma) => {
      const operator = await prisma.operator.findFirstOrThrow({
        select: { id: true },
      });
      await prisma.airAmbulanceRequest.update({
        where: { reference: declinable.reference },
        data: {
          status: 'QUOTED',
          selectedOperatorId: operator.id,
          quoteAmountMinor: 30_000_000,
          quoteCurrency: 'INR',
          quotedAt: new Date(),
        },
      });
    });
    const declined = await declinable.customer.post(
      `air-ambulance/requests/${declinable.reference}/quote/decline`,
      { headers: await csrfHeaders(declinable.customer) },
    );
    expect(declined.status()).toBe(200);
    expect((await declined.json()).data.status).toBe('DECLINED');
    await declinable.customer.dispose();

    const cancelled = await customer.post(`${base}/cancel`, { headers });
    expect(cancelled.status()).toBe(200);
    expect((await cancelled.json()).data.status).toBe('CANCELLED');
    expect((await customer.post(`${base}/cancel`, { headers })).status()).toBe(
      409,
    );
    const detail = (await (await customer.get(base)).json()).data;
    expect(detail.closedAt).toEqual(expect.any(String));

    // A closed request takes no documents.
    const fileId = await uploadPdf(
      customer,
      headers,
      'scan.pdf',
      'AIR_AMBULANCE_DOCUMENT',
    );
    expect(
      (
        await customer.post(`${base}/documents`, {
          headers,
          data: { fileId },
        })
      ).status(),
    ).toBe(409);

    // Another customer cannot withdraw it.
    const other = await playwright.request.newContext({ baseURL });
    await registerCustomer(other);
    expect(
      (
        await other.post(`${base}/cancel`, {
          headers: await csrfHeaders(other),
        })
      ).status(),
    ).toBe(404);
    await other.dispose();
    await customer.dispose();
  });
});

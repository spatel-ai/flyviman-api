import { APIRequestContext, expect, test } from '@playwright/test';
import {
  latestLinkToken,
  outbox,
  PASSWORD,
  registerCustomer,
  registerOperator,
  uniqueEmail,
  uploadPdf,
} from './support/data.js';
import { withPrisma } from './support/db.js';
import {
  addAircraftDocument,
  aircraftBody,
  approvedOperator,
} from './support/fleet.js';
import { csrfHeaders, signIn } from './support/session.js';

type Playwright = {
  request: { newContext(options: object): Promise<APIRequestContext> };
};

type Permissions = {
  capabilities: ('MANAGE_AIRCRAFT' | 'MANAGE_AVAILABILITY')[];
  allAircraft?: boolean;
  aircraftIds?: string[];
};

/** Days from now as an ISO timestamp in UTC. */
function inDays(days: number, hours = 0): string {
  const at = new Date();
  at.setUTCHours(0, 0, 0, 0);
  return new Date(
    at.getTime() + days * 86_400_000 + hours * 3_600_000,
  ).toISOString();
}

/** An approved operator on `admin` with two draft aircraft, A and B. */
async function fleet(
  admin: APIRequestContext,
  playwright: Playwright,
  baseURL: string | undefined,
) {
  const { homeBaseId } = await approvedOperator(admin, playwright, baseURL);
  const headers = await csrfHeaders(admin);
  const ids: string[] = [];
  for (let i = 0; i < 2; i += 1) {
    const created = await admin.post('operator/aircraft', {
      headers,
      data: aircraftBody(homeBaseId),
    });
    expect(created.status()).toBe(201);
    ids.push((await created.json()).data.id as string);
  }
  return { homeBaseId, a: ids[0], b: ids[1], headers };
}

/** Invites `email` with the permissions given. */
async function invite(
  admin: APIRequestContext,
  email: string,
  permissions: Permissions,
) {
  return admin.post('operator/staff', {
    headers: await csrfHeaders(admin),
    data: { email, allAircraft: false, aircraftIds: [], ...permissions },
  });
}

/** Invites, accepts the emailed link and signs in, in a context of its own. */
async function staffMember(
  admin: APIRequestContext,
  playwright: Playwright,
  baseURL: string | undefined,
  permissions: Permissions,
) {
  const email = uniqueEmail('staff');
  const invited = await invite(admin, email, permissions);
  expect(invited.status()).toBe(201);
  const memberId = (await invited.json()).data.id as string;
  const staff = await playwright.request.newContext({ baseURL });
  const token = await latestLinkToken(staff, email);
  expect(
    (
      await staff.post('auth/password/reset', {
        data: { token, password: PASSWORD },
      })
    ).status(),
  ).toBe(204);
  const login = await staff.post('auth/login', {
    data: { email, password: PASSWORD },
  });
  expect(login.status()).toBe(200);
  return { staff, email, memberId };
}

function audits(entityId: string) {
  return withPrisma((prisma) =>
    prisma.auditLog.findMany({
      where: { entityId },
      orderBy: { createdAt: 'asc' },
      select: { action: true, actorRole: true, reason: true },
    }),
  );
}

test.describe('operator staff: invitations', () => {
  test('an administrator invites staff, who accept the emailed link and sign in', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { a } = await fleet(request, playwright, baseURL);
    const email = uniqueEmail('staff');
    const invited = await invite(request, email, {
      capabilities: ['MANAGE_AVAILABILITY'],
      aircraftIds: [a],
    });
    expect(invited.status()).toBe(201);
    expect((await invited.json()).data).toMatchObject({
      email,
      status: 'INVITED',
      capabilities: ['MANAGE_AVAILABILITY'],
      allAircraft: false,
      aircraftIds: [a],
    });
    const message = (await outbox(request, email))[0] as {
      templateKey?: string;
      body: string;
    };
    expect(message.body).toContain('/reset-password?token=');

    const staff = await playwright.request.newContext({ baseURL });
    const token = await latestLinkToken(staff, email);
    expect(
      (
        await staff.post('auth/password/reset', {
          data: { token, password: PASSWORD },
        })
      ).status(),
    ).toBe(204);
    const login = await staff.post('auth/login', {
      data: { email, password: PASSWORD },
    });
    expect(login.status()).toBe(200);
    expect((await login.json()).data).toMatchObject({
      role: 'OPERATOR_STAFF',
      status: 'ACTIVE',
    });

    // The portal learns what the person may do.
    const profile = (await (await staff.get('operator/profile')).json()).data;
    expect(profile.access).toEqual({
      role: 'OPERATOR_STAFF',
      capabilities: ['MANAGE_AVAILABILITY'],
      allAircraft: false,
      aircraftIds: [a],
    });
    const adminProfile = (await (await request.get('operator/profile')).json())
      .data;
    expect(adminProfile.access).toMatchObject({
      role: 'OPERATOR_ADMIN',
      allAircraft: true,
    });

    const list = (await (await request.get('operator/staff')).json()).data;
    expect(list).toEqual([
      expect.objectContaining({ email, status: 'ACTIVE' }),
    ]);
    // Staff never manage the team.
    expect((await staff.get('operator/staff')).status()).toBe(403);
    await staff.dispose();
  });

  test('re-inviting a pending invitation re-sends it; an address in use is refused', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { a, b } = await fleet(request, playwright, baseURL);
    const email = uniqueEmail('staff');
    const first = await invite(request, email, {
      capabilities: ['MANAGE_AIRCRAFT'],
      aircraftIds: [a],
    });
    const memberId = (await first.json()).data.id as string;
    const again = await invite(request, email, {
      capabilities: ['MANAGE_AVAILABILITY'],
      aircraftIds: [b],
    });
    expect(again.status()).toBe(201);
    expect((await again.json()).data).toMatchObject({
      id: memberId,
      status: 'INVITED',
      capabilities: ['MANAGE_AVAILABILITY'],
      aircraftIds: [b],
    });
    expect((await audits(memberId)).map((row) => row.action)).toEqual([
      'operator_staff.invite',
      'operator_staff.reinvite',
    ]);

    // A customer's address, an internal account and another operator's
    // staff cannot be invited.
    const customer = await playwright.request.newContext({ baseURL });
    const { email: customerEmail } = await registerCustomer(customer);
    await customer.dispose();
    for (const taken of [customerEmail, 'ops@flyviman.test']) {
      const refused = await invite(request, taken, {
        capabilities: ['MANAGE_AIRCRAFT'],
        allAircraft: true,
      });
      expect(refused.status()).toBe(409);
      expect((await refused.json()).error.code).toBe('USER_ALREADY_EXISTS');
    }
    const other = await playwright.request.newContext({ baseURL });
    await fleet(other, playwright, baseURL);
    const poached = await invite(other, email, {
      capabilities: ['MANAGE_AIRCRAFT'],
      allAircraft: true,
    });
    expect(poached.status()).toBe(409);
    await other.dispose();
  });

  test('accepted staff cannot be invited again; permissions are validated', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { a } = await fleet(request, playwright, baseURL);
    const { staff, email } = await staffMember(request, playwright, baseURL, {
      capabilities: ['MANAGE_AIRCRAFT'],
      aircraftIds: [a],
    });
    await staff.dispose();
    const again = await invite(request, email, {
      capabilities: ['MANAGE_AIRCRAFT'],
      aircraftIds: [a],
    });
    expect(again.status()).toBe(409);

    // Another operator's aircraft, no permission, no aircraft.
    const other = await playwright.request.newContext({ baseURL });
    const { a: foreign } = await fleet(other, playwright, baseURL);
    await other.dispose();
    for (const bad of [
      { capabilities: ['MANAGE_AIRCRAFT'], aircraftIds: [foreign] },
      { capabilities: [], aircraftIds: [a] },
      { capabilities: ['MANAGE_AIRCRAFT'], aircraftIds: [] },
      { capabilities: ['ADMIN'], aircraftIds: [a] },
    ] as Permissions[]) {
      const refused = await invite(request, uniqueEmail('staff'), bad);
      expect(refused.status()).toBe(400);
      expect((await refused.json()).error.code).toBe('VALIDATION_ERROR');
    }
  });

  test('only an approved operator administrator can invite', async ({
    request,
    playwright,
    baseURL,
  }) => {
    await registerOperator(request);
    const unapproved = await invite(request, uniqueEmail('staff'), {
      capabilities: ['MANAGE_AIRCRAFT'],
      allAircraft: true,
    });
    expect(unapproved.status()).toBe(409);
    expect((await unapproved.json()).error.code).toBe('OPERATOR_NOT_APPROVED');

    for (const account of ['customer', 'ops', 'superAdmin'] as const) {
      const other = await playwright.request.newContext({ baseURL });
      await signIn(other, account);
      expect((await other.get('operator/staff')).status()).toBe(403);
      await other.dispose();
    }
  });
});

test.describe('operator staff: what they can reach', () => {
  test('availability staff manage time on their assigned aircraft only', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { homeBaseId, a, b } = await fleet(request, playwright, baseURL);
    const { staff } = await staffMember(request, playwright, baseURL, {
      capabilities: ['MANAGE_AVAILABILITY'],
      aircraftIds: [a],
    });
    const headers = await csrfHeaders(staff);

    const list = (await (await staff.get('operator/aircraft')).json()).data;
    expect(list.map((row: { id: string }) => row.id)).toEqual([a]);
    expect((await staff.get(`operator/aircraft/${a}`)).status()).toBe(200);
    expect((await staff.get(`operator/aircraft/${b}`)).status()).toBe(404);

    // No aircraft editing, no new aircraft, but grounding is allowed.
    expect(
      (
        await staff.patch(`operator/aircraft/${a}`, {
          headers,
          data: { passengerCapacity: 6 },
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await staff.post('operator/aircraft', {
          headers,
          data: aircraftBody(homeBaseId),
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await staff.patch(`operator/aircraft/${a}/availability-status`, {
          headers,
          data: { status: 'MAINTENANCE' },
        })
      ).status(),
    ).toBe(200);

    const slot = { kind: 'OPEN', startsAt: inDays(3), endsAt: inDays(4) };
    expect(
      (
        await staff.post(`operator/aircraft/${a}/availability/slots`, {
          headers,
          data: slot,
        })
      ).status(),
    ).toBe(201);
    expect(
      (
        await staff.post(`operator/aircraft/${b}/availability/slots`, {
          headers,
          data: slot,
        })
      ).status(),
    ).toBe(404);

    const timeline = (
      await (
        await staff.get('operator/availability', {
          params: { from: inDays(0), to: inDays(7) },
        })
      ).json()
    ).data;
    expect(timeline.aircraft.map((row: { id: string }) => row.id)).toEqual([a]);
    expect((await staff.get('operator/availability/conflicts')).status()).toBe(
      200,
    );
    await staff.dispose();
  });

  test('aircraft staff edit and submit their aircraft, but not its calendar', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { a, b } = await fleet(request, playwright, baseURL);
    const bDocument = await addAircraftDocument(request, b, 'INSURANCE');
    const { staff } = await staffMember(request, playwright, baseURL, {
      capabilities: ['MANAGE_AIRCRAFT'],
      aircraftIds: [a],
    });
    const headers = await csrfHeaders(staff);

    expect(
      (
        await staff.patch(`operator/aircraft/${a}`, {
          headers,
          data: { passengerCapacity: 6 },
        })
      ).status(),
    ).toBe(200);
    for (const type of ['REGISTRATION', 'AIRWORTHINESS', 'INSURANCE']) {
      await addAircraftDocument(staff, a, type);
    }
    const submit = await staff.post(`operator/aircraft/${a}/submit`, {
      headers,
    });
    expect(submit.status()).toBe(200);
    expect((await submit.json()).data.listingStatus).toBe('PENDING_REVIEW');
    const submitted = (await audits(a)).find(
      (row) => row.action === 'aircraft.submit',
    );
    expect(submitted?.actorRole).toBe('OPERATOR_STAFF');

    expect(
      (
        await staff.get(`operator/aircraft/${a}/availability`, {
          params: { from: inDays(0), to: inDays(7) },
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await staff.get('operator/availability', {
          params: { from: inDays(0), to: inDays(7) },
        })
      ).status(),
    ).toBe(403);

    // Files: their aircraft's documents open; another aircraft's do not.
    const detail = (await (await staff.get(`operator/aircraft/${a}`)).json())
      .data;
    const own = detail.documents[0].fileId as string;
    expect((await staff.get(`documents/${own}/download`)).status()).toBe(200);
    const foreignFile = await withPrisma((prisma) =>
      prisma.aircraftDocument.findUniqueOrThrow({
        where: { id: bDocument.id },
        select: { fileId: true },
      }),
    );
    expect(
      (await staff.get(`documents/${foreignFile.fileId}/download`)).status(),
    ).toBe(404);
    // An upload of their own cannot be attached to an aircraft out of reach.
    const fileId = await uploadPdf(
      staff,
      headers,
      'insurance.pdf',
      'AIRCRAFT_DOCUMENT',
    );
    expect(
      (
        await staff.post(`operator/aircraft/${b}/documents`, {
          headers,
          data: { type: 'INSURANCE', fileId, expiresAt: '2030-12-31' },
        })
      ).status(),
    ).toBe(404);
    await staff.dispose();
  });

  test('all aircraft includes ones added later; a permission change applies at once', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { homeBaseId, a, headers } = await fleet(
      request,
      playwright,
      baseURL,
    );
    const { staff, memberId } = await staffMember(
      request,
      playwright,
      baseURL,
      { capabilities: ['MANAGE_AIRCRAFT'], allAircraft: true },
    );
    const created = await request.post('operator/aircraft', {
      headers,
      data: aircraftBody(homeBaseId),
    });
    const c = (await created.json()).data.id as string;
    expect((await staff.get(`operator/aircraft/${c}`)).status()).toBe(200);

    const narrowed = await request.patch(`operator/staff/${memberId}`, {
      headers,
      data: { allAircraft: false, aircraftIds: [a] },
    });
    expect(narrowed.status()).toBe(200);
    expect((await narrowed.json()).data).toMatchObject({
      allAircraft: false,
      aircraftIds: [a],
    });
    // The very next request sees the change.
    expect((await staff.get(`operator/aircraft/${c}`)).status()).toBe(404);
    expect((await staff.get(`operator/aircraft/${a}`)).status()).toBe(200);
    expect((await audits(memberId)).map((row) => row.action)).toContain(
      'operator_staff.update',
    );
    await staff.dispose();
  });

  test('staff of a suspended operator can ground an aircraft but not offer time', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { a } = await fleet(request, playwright, baseURL);
    const { staff } = await staffMember(request, playwright, baseURL, {
      capabilities: ['MANAGE_AVAILABILITY'],
      aircraftIds: [a],
    });
    await withPrisma(async (prisma) => {
      const { operatorId } = await prisma.aircraft.findUniqueOrThrow({
        where: { id: a },
        select: { operatorId: true },
      });
      await prisma.operator.update({
        where: { id: operatorId },
        data: { status: 'SUSPENDED' },
      });
    });
    const headers = await csrfHeaders(staff);
    expect(
      (
        await staff.post(`operator/aircraft/${a}/availability/blocks`, {
          headers,
          data: {
            reason: 'MAINTENANCE',
            startsAt: inDays(2),
            endsAt: inDays(3),
          },
        })
      ).status(),
    ).toBe(201);
    const offer = await staff.post(
      `operator/aircraft/${a}/availability/slots`,
      {
        headers,
        data: { kind: 'OPEN', startsAt: inDays(5), endsAt: inDays(6) },
      },
    );
    expect(offer.status()).toBe(409);
    expect((await offer.json()).error.code).toBe('OPERATOR_NOT_APPROVED');
    await staff.dispose();
  });
});

test.describe('operator staff: suspension and removal', () => {
  test('suspending signs staff out at once; reinstating lets them back in', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { a, headers } = await fleet(request, playwright, baseURL);
    const { staff, email, memberId } = await staffMember(
      request,
      playwright,
      baseURL,
      { capabilities: ['MANAGE_AIRCRAFT'], aircraftIds: [a] },
    );
    expect(
      (
        await request.patch(`operator/staff/${memberId}`, {
          headers,
          data: { status: 'SUSPENDED' },
        })
      ).status(),
    ).toBe(400);
    const suspended = await request.patch(`operator/staff/${memberId}`, {
      headers,
      data: { status: 'SUSPENDED', reason: 'Left the dispatch desk' },
    });
    expect(suspended.status()).toBe(200);
    expect((await suspended.json()).data.status).toBe('SUSPENDED');
    expect((await staff.get('operator/aircraft')).status()).toBe(401);
    const login = await staff.post('auth/login', {
      data: { email, password: PASSWORD },
    });
    expect(login.status()).toBe(403);

    const reinstated = await request.patch(`operator/staff/${memberId}`, {
      headers,
      data: { status: 'ACTIVE' },
    });
    expect((await reinstated.json()).data.status).toBe('ACTIVE');
    const back = await playwright.request.newContext({ baseURL });
    expect(
      (
        await back.post('auth/login', { data: { email, password: PASSWORD } })
      ).status(),
    ).toBe(200);
    expect((await back.get(`operator/aircraft/${a}`)).status()).toBe(200);

    const trail = await audits(memberId);
    expect(trail.map((row) => row.action)).toEqual([
      'operator_staff.invite',
      'operator_staff.suspend',
      'operator_staff.reinstate',
    ]);
    expect(trail.every((row) => row.actorRole === 'OPERATOR_ADMIN')).toBe(true);
    expect(trail[1].reason).toBe('Left the dispatch desk');
    await back.dispose();
    await staff.dispose();
  });

  test('removing staff ends their access; the address can be invited again', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { a, headers } = await fleet(request, playwright, baseURL);
    const { staff, email, memberId } = await staffMember(
      request,
      playwright,
      baseURL,
      { capabilities: ['MANAGE_AIRCRAFT'], aircraftIds: [a] },
    );
    expect(
      (
        await request.delete(`operator/staff/${memberId}`, {
          headers,
          data: {},
        })
      ).status(),
    ).toBe(400);
    expect(
      (
        await request.delete(`operator/staff/${memberId}`, {
          headers,
          data: { reason: 'Contract ended' },
        })
      ).status(),
    ).toBe(204);
    const list = (await (await request.get('operator/staff')).json()).data;
    expect(list.map((row: { id: string }) => row.id)).not.toContain(memberId);
    expect((await staff.get('operator/aircraft')).status()).toBe(401);
    expect(
      (
        await staff.post('auth/login', { data: { email, password: PASSWORD } })
      ).status(),
    ).toBe(403);

    // Invited again: the old password no longer works; a fresh link does.
    const again = await invite(request, email, {
      capabilities: ['MANAGE_AVAILABILITY'],
      aircraftIds: [a],
    });
    expect(again.status()).toBe(201);
    expect((await again.json()).data.status).toBe('INVITED');
    const returning = await playwright.request.newContext({ baseURL });
    expect(
      (
        await returning.post('auth/login', {
          data: { email, password: PASSWORD },
        })
      ).status(),
    ).toBe(401);
    const token = await latestLinkToken(returning, email);
    expect(
      (
        await returning.post('auth/password/reset', {
          data: { token, password: PASSWORD },
        })
      ).status(),
    ).toBe(204);
    expect(
      (
        await returning.post('auth/login', {
          data: { email, password: PASSWORD },
        })
      ).status(),
    ).toBe(200);
    expect((await returning.get(`operator/aircraft/${a}`)).status()).toBe(200);
    await returning.dispose();
    await staff.dispose();
  });

  test('administrators and other operators are not managed through these routes', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { headers } = await fleet(request, playwright, baseURL);
    const me = (await (await request.get('me')).json()).data.id as string;
    const own = await withPrisma((prisma) =>
      prisma.operatorMember.findUniqueOrThrow({
        where: { userId: me },
        select: { id: true },
      }),
    );
    expect(
      (
        await request.patch(`operator/staff/${own.id}`, {
          headers,
          data: { status: 'SUSPENDED', reason: 'Testing' },
        })
      ).status(),
    ).toBe(404);
    expect(
      (
        await request.delete(`operator/staff/${own.id}`, {
          headers,
          data: { reason: 'Testing' },
        })
      ).status(),
    ).toBe(404);

    // Another operator cannot touch this operator's staff.
    const rival = await playwright.request.newContext({ baseURL });
    await fleet(rival, playwright, baseURL);
    const mine = await invite(request, uniqueEmail('staff'), {
      capabilities: ['MANAGE_AIRCRAFT'],
      allAircraft: true,
    });
    const memberId = (await mine.json()).data.id as string;
    expect(
      (
        await rival.patch(`operator/staff/${memberId}`, {
          headers: await csrfHeaders(rival),
          data: { status: 'SUSPENDED', reason: 'Not mine' },
        })
      ).status(),
    ).toBe(404);
    await rival.dispose();
  });
});

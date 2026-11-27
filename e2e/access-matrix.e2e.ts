import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  type APIRequestContext,
  type APIResponse,
  expect,
  test,
} from '@playwright/test';
import { POC_ORIGIN } from '../playwright.config.js';
import type { AccountName } from './support/accounts.js';
import {
  latestLinkToken,
  PASSWORD,
  registerCustomer,
  uniqueEmail,
} from './support/data.js';
import { aircraftBody, approvedOperator } from './support/fleet.js';
import { listedJet, locationId, searchFor } from './support/pricing.js';
import { cookie, csrfHeaders, signIn } from './support/session.js';

/**
 * Proof that every route is protected and reachable only by the roles
 * allowed (security-rbac.md, Authorisation). The golden file is the reviewed
 * table: a change to who may call what fails here until it is reviewed and
 * the file updated. Development tools (`/dev/*`) are left out: they exist
 * only where `ENABLE_DEV_TOOLS` is on.
 */

type Access = 'public' | string[];
type Matrix = Record<string, Access>;
type Role =
  | 'CUSTOMER'
  | 'OPERATOR_ADMIN'
  | 'OPERATOR_STAFF'
  | 'OPS'
  | 'FINANCE_ADMIN'
  | 'SUPER_ADMIN';

interface RouteAccess {
  method: string;
  path: string;
  public: boolean;
  roles: string[];
}

const GOLDEN = JSON.parse(
  readFileSync(`${import.meta.dirname}/support/access-matrix.json`, 'utf8'),
) as Matrix;

const ROUTES = Object.entries(GOLDEN).map(([key, access]) => {
  const [method, path] = key.split(' ');
  return { method, path, access };
});

const SEEDED: Record<Exclude<Role, 'OPERATOR_STAFF'>, AccountName> = {
  CUSTOMER: 'customer',
  OPERATOR_ADMIN: 'operatorAdmin',
  OPS: 'ops',
  FINANCE_ADMIN: 'finance',
  SUPER_ADMIN: 'superAdmin',
};

const ROLES: Role[] = [
  'CUSTOMER',
  'OPERATOR_ADMIN',
  'OPERATOR_STAFF',
  'OPS',
  'FINANCE_ADMIN',
  'SUPER_ADMIN',
];

/** The reference alphabet has no 0, 1, I, L or O (src/common/reference.ts). */
const REFERENCE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

function reference(kind: 'BK' | 'AA' | 'PY' | 'QT'): string {
  const code = Array.from(
    { length: 6 },
    () =>
      REFERENCE_ALPHABET[Math.floor(Math.random() * REFERENCE_ALPHABET.length)],
  ).join('');
  return `FLY-${kind}-${code}`;
}

/** A relative URL with every path parameter filled in a valid format. */
function fill(path: string): string {
  return path.slice(1).replace(/:(\w+)/g, (_, name: string) => {
    switch (name) {
      case 'reference':
        if (path.includes('air-ambulance')) return reference('AA');
        if (path.startsWith('/quotes/')) return reference('QT');
        if (/^\/(admin\/)?payments\//.test(path)) return reference('PY');
        return reference('BK');
      case 'slug':
        return 'terms-of-use';
      case 'key':
        return 'booking.confirmed';
      case 'report':
        // Open to every role the route admits (REPORTS in the controller).
        return 'overview';
      case 'provider':
        return 'razorpay';
      default:
        return randomUUID();
    }
  });
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

async function errorCode(response: APIResponse): Promise<string | undefined> {
  if (response.status() < 400) return undefined;
  try {
    return ((await response.json()) as { error?: { code?: string } }).error
      ?.code;
  } catch {
    return undefined;
  }
}

/** Runs the checks in batches, collecting every failure instead of stopping. */
async function sweep<T extends { method: string; path: string }>(
  items: T[],
  call: (method: string, url: string) => Promise<APIResponse>,
  check: (route: T, status: number, code: string | undefined) => string | null,
): Promise<string[]> {
  const failures: string[] = [];
  for (let i = 0; i < items.length; i += 25) {
    await Promise.all(
      items.slice(i, i + 25).map(async (route) => {
        const response = await call(route.method, fill(route.path));
        const problem = check(
          route,
          response.status(),
          await errorCode(response),
        );
        if (problem) failures.push(`${route.method} ${route.path}: ${problem}`);
      }),
    );
  }
  return failures.sort();
}

function toMatrix(routes: RouteAccess[]): Matrix {
  return Object.fromEntries(
    routes.map((route) => [
      `${route.method} ${route.path}`,
      route.public ? 'public' : [...route.roles].sort(),
    ]),
  );
}

async function liveRoutes(request: APIRequestContext): Promise<RouteAccess[]> {
  await signIn(request, 'superAdmin');
  const response = await request.get('admin/roles');
  expect(response.status()).toBe(200);
  return ((await response.json()) as { data: { routes: RouteAccess[] } }).data
    .routes;
}

/** An operator staff member with every capability on every aircraft. */
async function operatorStaff(
  playwright: {
    request: { newContext(options: object): Promise<APIRequestContext> };
  },
  baseURL: string | undefined,
): Promise<APIRequestContext> {
  const admin = await playwright.request.newContext({ baseURL });
  await approvedOperator(admin, playwright, baseURL);
  const email = uniqueEmail('staff');
  const invited = await admin.post('operator/staff', {
    headers: await csrfHeaders(admin),
    data: {
      email,
      capabilities: [
        'MANAGE_AIRCRAFT',
        'MANAGE_AVAILABILITY',
        'MANAGE_EMPTY_LEGS',
        'MANAGE_BOOKINGS',
      ],
      allAircraft: true,
      aircraftIds: [],
    },
  });
  expect(invited.status()).toBe(201);
  await admin.dispose();
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
  return staff;
}

test.describe('route access matrix', () => {
  test('the enforced route table equals the reviewed golden file', async ({
    request,
  }) => {
    const live = (await liveRoutes(request)).filter(
      (route) => !route.path.startsWith('/dev/'),
    );
    const keys = live.map((route) => `${route.method} ${route.path}`);
    // A method and path declared twice would hide one of the declarations.
    expect(keys.filter((key, i) => keys.indexOf(key) !== i)).toEqual([]);
    expect(toMatrix(live)).toEqual(GOLDEN);
    // A private route with no roles is unreachable (the guard fails closed).
    expect(ROUTES.filter((route) => route.access.length === 0)).toEqual([]);
  });

  test('development tools do not exist where they are switched off', async ({
    request,
    playwright,
  }) => {
    const dev = (await liveRoutes(request)).filter(
      (route) =>
        route.path.startsWith('/dev/') &&
        // The local file store is served on a host without dev tools
        // (poc-host.e2e.ts), behind signed links.
        route.path !== '/dev/storage/:token',
    );
    expect(dev.length).toBeGreaterThan(0);
    const poc = await playwright.request.newContext({
      baseURL: `${POC_ORIGIN}/api/v1/`,
    });
    const failures = await sweep(
      dev,
      (method, url) => poc.fetch(url, { method }),
      (_route, status) => (status === 404 ? null : `answered ${status}`),
    );
    expect(failures).toEqual([]);
    await poc.dispose();
  });

  test('anonymous callers get 401 on every private route and reach public ones', async ({
    playwright,
    baseURL,
  }) => {
    // A context that has never held a session cookie.
    const anonymous = await playwright.request.newContext({ baseURL });
    const failures = await sweep(
      ROUTES.filter(
        (route) => route.access !== 'public' || route.method === 'GET',
      ),
      (method, url) => anonymous.fetch(url, { method }),
      (route, status, code) => {
        if (route.access === 'public') {
          return status === 401 || status === 403 || status >= 500
            ? `public route answered ${status} ${code}`
            : null;
        }
        return status === 401 && code === 'UNAUTHENTICATED'
          ? null
          : `answered ${status} ${code}`;
      },
    );
    expect(failures).toEqual([]);
    await anonymous.dispose();
  });

  for (const role of ROLES) {
    test(`${role}: 403 FORBIDDEN wherever the role is not allowed; allowed reads pass the guard`, async ({
      playwright,
      baseURL,
    }) => {
      test.setTimeout(120_000);
      let caller: APIRequestContext;
      if (role === 'OPERATOR_STAFF') {
        caller = await operatorStaff(playwright, baseURL);
      } else {
        caller = await playwright.request.newContext({ baseURL });
        await signIn(caller, SEEDED[role]);
      }
      const csrf = { 'X-CSRF-Token': (await cookie(caller, 'csrf_token'))! };

      const failures = await sweep(
        ROUTES.filter(
          (route) =>
            route.access !== 'public' &&
            // An allowed role is never sent a state-changing request.
            (!route.access.includes(role) || route.method === 'GET'),
        ),
        (method, url) =>
          caller.fetch(url, {
            method,
            headers: MUTATING.has(method) ? csrf : undefined,
          }),
        (route, status, code) => {
          if (!route.access.includes(role)) {
            return status === 403 && code === 'FORBIDDEN'
              ? null
              : `not allowed, answered ${status} ${code}`;
          }
          if (status === 401 || code === 'FORBIDDEN' || status >= 500) {
            return `allowed, answered ${status} ${code}`;
          }
          return null;
        },
      );
      expect(failures).toEqual([]);
      await caller.dispose();
    });
  }
});

test.describe('cross-tenant', () => {
  test('another operator cannot remove this operator’s staff member', async ({
    request,
    playwright,
    baseURL,
  }) => {
    await approvedOperator(request, playwright, baseURL);
    const invited = await request.post('operator/staff', {
      headers: await csrfHeaders(request),
      data: {
        email: uniqueEmail('staff'),
        capabilities: ['MANAGE_AIRCRAFT'],
        allAircraft: true,
        aircraftIds: [],
      },
    });
    expect(invited.status()).toBe(201);
    const memberId = ((await invited.json()) as { data: { id: string } }).data
      .id;

    const rival = await playwright.request.newContext({ baseURL });
    await approvedOperator(rival, playwright, baseURL);
    const removed = await rival.delete(`operator/staff/${memberId}`, {
      headers: await csrfHeaders(rival),
      data: { reason: 'Not mine to remove' },
    });
    expect(removed.status()).toBe(404);
    expect(
      ((await removed.json()) as { error: { code: string } }).error.code,
    ).toBe('NOT_FOUND');

    // The member is still on the owner's team, unchanged.
    const team = await request.get('operator/staff');
    expect(team.status()).toBe(200);
    expect(
      ((await team.json()) as { data: { id: string; status: string }[] }).data,
    ).toContainEqual(
      expect.objectContaining({ id: memberId, status: 'INVITED' }),
    );
    await rival.dispose();
  });

  test('another operator, and staff without the aircraft, cannot see or decide a change request', async ({
    request,
    playwright,
    baseURL,
  }) => {
    // Operator A (`request`): a priced jet, a booking request and a change request on it.
    const trip = await listedJet({ request, playwright, baseURL });
    expect(
      (
        await request.put(`operator/aircraft/${trip.aircraftId}/pricing`, {
          headers: await csrfHeaders(request),
          data: {
            hourlyRateMinor: 18_000_000,
            taxInclusive: false,
            commissionInclusive: false,
            minBillableHours: null,
          },
        })
      ).status(),
    ).toBe(200);
    const searched = await searchFor(request, trip);
    const customer = await playwright.request.newContext({ baseURL });
    await registerCustomer(customer);
    const created = await customer.post('bookings', {
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
    expect(created.status()).toBe(201);
    const reference = (
      (await created.json()) as { data: { reference: string } }
    ).data.reference;
    const asked = await customer.post(`bookings/${reference}/change-requests`, {
      headers: await csrfHeaders(customer),
      data: { details: 'Could we leave an hour later?' },
    });
    expect(asked.status()).toBe(201);
    const changeId = ((await asked.json()) as { data: { id: string } }).data.id;
    const decideBody = { decision: 'APPROVED', note: 'Not yours to answer' };
    const decide = async (actor: APIRequestContext) =>
      actor.post(`operator/change-requests/${changeId}/decide`, {
        headers: await csrfHeaders(actor),
        data: decideBody,
      });

    // Operator B's administrator neither lists nor decides it.
    const rival = await playwright.request.newContext({ baseURL });
    await approvedOperator(rival, playwright, baseURL);
    const rivalList = await rival.get('operator/change-requests', {
      params: { pageSize: '100' },
    });
    expect(rivalList.status()).toBe(200);
    expect(
      ((await rivalList.json()) as { data: { id: string }[] }).data.map(
        (entry) => entry.id,
      ),
    ).not.toContain(changeId);
    const rivalDecided = await decide(rival);
    expect(rivalDecided.status()).toBe(404);
    expect(
      ((await rivalDecided.json()) as { error: { code: string } }).error.code,
    ).toBe('NOT_FOUND');

    // Operator A staff with bookings rights but only another aircraft in reach.
    const other = await request.post('operator/aircraft', {
      headers: await csrfHeaders(request),
      data: aircraftBody(
        await locationId(request, 'BOM'),
        `VT-${randomUUID().slice(0, 3).toUpperCase()}`,
      ),
    });
    expect(other.status()).toBe(201);
    const otherId = ((await other.json()) as { data: { id: string } }).data.id;
    const email = uniqueEmail('staff');
    const invited = await request.post('operator/staff', {
      headers: await csrfHeaders(request),
      data: {
        email,
        capabilities: ['MANAGE_BOOKINGS'],
        allAircraft: false,
        aircraftIds: [otherId],
      },
    });
    expect(invited.status()).toBe(201);
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
    const staffList = await staff.get('operator/change-requests', {
      params: { pageSize: '100' },
    });
    expect(staffList.status()).toBe(200);
    expect(
      ((await staffList.json()) as { data: { id: string }[] }).data.map(
        (entry) => entry.id,
      ),
    ).not.toContain(changeId);
    expect((await decide(staff)).status()).toBe(404);

    // Still open for its own operator.
    const ownList = await request.get('operator/change-requests');
    expect(
      ((await ownList.json()) as { data: { id: string; status: string }[] })
        .data,
    ).toContainEqual(
      expect.objectContaining({ id: changeId, status: 'REQUESTED' }),
    );
    await Promise.all([customer.dispose(), rival.dispose(), staff.dispose()]);
  });
});

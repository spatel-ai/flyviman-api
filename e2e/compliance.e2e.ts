import { APIRequestContext, expect, test } from '@playwright/test';
import { outbox, uploadPdf } from './support/data.js';
import { withPrisma } from './support/db.js';
import {
  addAircraftDocument,
  aircraftBody,
  approvedOperator,
} from './support/fleet.js';
import { csrfHeaders, signIn } from './support/session.js';

// The job holds one lock across instances, so these run one after another.
test.describe.configure({ mode: 'serial' });

/** A calendar date in India, `days` from today (`YYYY-MM-DD`). */
function indiaDate(days: number): string {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
  }).format(new Date());
  return new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

async function runJob(request: APIRequestContext) {
  const response = await request.post('dev/jobs/document-expiry-alerts', {
    headers: await csrfHeaders(request),
  });
  expect(response.status()).toBe(200);
  const result = (await response.json()).data;
  expect(result.skipped).toBe(false);
  return result as { alerted: number };
}

function alertsFor(documentIds: string[]) {
  return withPrisma((prisma) =>
    prisma.documentExpiryAlert.findMany({
      where: { documentId: { in: documentIds } },
      select: { documentId: true, threshold: true },
      orderBy: { threshold: 'asc' },
    }),
  );
}

/**
 * An approved operator with a live (approved) aircraft whose three required
 * documents are current, on `request`.
 */
async function liveAircraft(
  request: APIRequestContext,
  playwright: Parameters<typeof approvedOperator>[1],
  baseURL: string | undefined,
) {
  const { homeBaseId } = await approvedOperator(request, playwright, baseURL);
  const created = await request.post('operator/aircraft', {
    headers: await csrfHeaders(request),
    data: aircraftBody(homeBaseId),
  });
  const aircraft = (await created.json()).data as {
    id: string;
    registration: string;
  };
  const documents: Record<string, string> = {};
  for (const type of ['REGISTRATION', 'AIRWORTHINESS', 'INSURANCE']) {
    documents[type] = (
      await addAircraftDocument(request, aircraft.id, type)
    ).id;
  }
  await withPrisma((prisma) =>
    prisma.aircraft.update({
      where: { id: aircraft.id },
      data: { listingStatus: 'APPROVED' },
    }),
  );
  const me = (await (await request.get('me')).json()).data as {
    id: string;
    email: string;
  };
  return { aircraft, documents, admin: me };
}

test.describe('document expiry', () => {
  test('alerts the operator once per threshold, by email and in the app', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { aircraft, documents, admin } = await liveAircraft(
      request,
      playwright,
      baseURL,
    );
    const operatorDocument = await withPrisma((prisma) =>
      prisma.operatorDocument.findFirstOrThrow({
        where: {
          operator: { members: { some: { userId: admin.id } } },
          type: 'AOC',
        },
        select: { id: true },
      }),
    );
    // Insurance lapses in five days, registration in twenty; the air
    // operator certificate lapsed yesterday (set directly: the API refuses
    // an expiry in the past).
    await withPrisma(async (prisma) => {
      await prisma.aircraftDocument.update({
        where: { id: documents.INSURANCE },
        data: { expiresAt: new Date(`${indiaDate(5)}T00:00:00Z`) },
      });
      await prisma.aircraftDocument.update({
        where: { id: documents.REGISTRATION },
        data: { expiresAt: new Date(`${indiaDate(20)}T00:00:00Z`) },
      });
      await prisma.operatorDocument.update({
        where: { id: operatorDocument.id },
        data: { expiresAt: new Date(`${indiaDate(-1)}T00:00:00Z`) },
      });
    });

    await runJob(request);
    const watched = [
      documents.INSURANCE,
      documents.REGISTRATION,
      operatorDocument.id,
    ];
    expect(await alertsFor(watched)).toEqual([
      { documentId: operatorDocument.id, threshold: 0 },
      { documentId: documents.INSURANCE, threshold: 7 },
      { documentId: documents.REGISTRATION, threshold: 30 },
    ]);
    const notifications = () =>
      withPrisma((prisma) =>
        prisma.notification.count({
          where: {
            userId: admin.id,
            templateKey: { in: ['document.expiring', 'document.expired'] },
          },
        }),
      );
    // Three alerts, each in the app and by email.
    expect(await notifications()).toBe(6);

    // In the app and by email, to the operator's administrator.
    const inbox = (await (await request.get('me/notifications')).json()).data;
    const keys = inbox.map((item: { templateKey: string }) => item.templateKey);
    expect(keys).toContain('document.expiring');
    expect(keys).toContain('document.expired');
    const expiring = inbox.find(
      (item: { templateKey: string }) =>
        item.templateKey === 'document.expiring',
    );
    expect(expiring.body).toContain(aircraft.registration);
    const mail = await outbox(request, admin.email);
    expect(
      mail.some((message) =>
        String(message.subject).includes(
          `Insurance for ${aircraft.registration}`,
        ),
      ),
    ).toBe(true);

    // A second run sends nothing new for these documents.
    await runJob(request);
    expect(await alertsFor(watched)).toHaveLength(3);
    expect(await notifications()).toBe(6);
    // Every email went out, and none keeps its address.
    const emails = await withPrisma((prisma) =>
      prisma.notification.findMany({
        where: {
          userId: admin.id,
          channel: 'EMAIL',
          templateKey: { in: ['document.expiring', 'document.expired'] },
        },
        select: { status: true, recipient: true },
      }),
    );
    expect(emails).toEqual(Array(3).fill({ status: 'SENT', recipient: null }));
  });

  test('a renewed copy ends the alerts, and an expired document takes the aircraft out of search', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { aircraft, documents } = await liveAircraft(
      request,
      playwright,
      baseURL,
    );
    const detail = async () =>
      (await (await request.get(`operator/aircraft/${aircraft.id}`)).json())
        .data as { searchBlockers: string[] };
    expect((await detail()).searchBlockers).toEqual([]);

    await withPrisma((prisma) =>
      prisma.aircraftDocument.update({
        where: { id: documents.AIRWORTHINESS },
        data: { expiresAt: new Date(`${indiaDate(-2)}T00:00:00Z`) },
      }),
    );
    expect((await detail()).searchBlockers).toEqual(['document:AIRWORTHINESS']);

    const ops = await playwright.request.newContext({ baseURL });
    await signIn(ops, 'ops');
    const listed = async () =>
      (
        await (
          await ops.get('admin/documents/expiring', {
            params: { kind: 'AIRCRAFT', withinDays: 90, pageSize: 100 },
          })
        ).json()
      ).data as { documentId: string; daysLeft: number }[];
    expect(
      (await listed()).find((row) => row.documentId === documents.AIRWORTHINESS)
        ?.daysLeft,
    ).toBe(-2);

    // The operator uploads a renewed certificate.
    const headers = await csrfHeaders(request);
    const fileId = await uploadPdf(
      request,
      headers,
      'airworthiness.pdf',
      'AIRCRAFT_DOCUMENT',
    );
    expect(
      (
        await request.post(`operator/aircraft/${aircraft.id}/documents`, {
          headers,
          data: {
            type: 'AIRWORTHINESS',
            fileId,
            expiresAt: indiaDate(365),
          },
        })
      ).status(),
    ).toBe(201);
    expect(
      (await listed()).some(
        (row) => row.documentId === documents.AIRWORTHINESS,
      ),
    ).toBe(false);
    await runJob(request);
    expect(await alertsFor([documents.AIRWORTHINESS])).toEqual([]);
    await ops.dispose();
  });

  test('only operations and super administrators read the expiring list', async ({
    playwright,
    baseURL,
  }) => {
    for (const [account, status] of [
      ['ops', 200],
      ['superAdmin', 200],
      ['finance', 403],
      ['operatorAdmin', 403],
      ['customer', 403],
    ] as const) {
      const context = await playwright.request.newContext({ baseURL });
      await signIn(context, account);
      expect(
        (await context.get('admin/documents/expiring')).status(),
        account,
      ).toBe(status);
      await context.dispose();
    }
    const ops = await playwright.request.newContext({ baseURL });
    await signIn(ops, 'ops');
    for (const params of [
      { withinDays: 0 },
      { withinDays: 91 },
      { kind: 'X' },
    ] as Record<string, string | number>[]) {
      expect(
        (await ops.get('admin/documents/expiring', { params })).status(),
      ).toBe(400);
    }
    await ops.dispose();
  });
});

test.describe('notification outbox', () => {
  test('the dispatcher sends a due message once and keeps no address', async ({
    request,
  }) => {
    await signIn(request, 'operatorAdmin');
    const me = (await (await request.get('me')).json()).data as {
      id: string;
      email: string;
    };
    const subject = `VT-${Date.now()}`;
    const queued = await withPrisma((prisma) =>
      prisma.notification.create({
        data: {
          userId: me.id,
          channel: 'EMAIL',
          templateKey: 'document.expiring',
          payload: {
            document: 'Insurance',
            subject,
            date: '1 Dec 2030',
            when: 'in 9 days',
          },
          status: 'QUEUED',
          recipient: me.email,
          nextAttemptAt: new Date(Date.now() - 1000),
        },
      }),
    );
    const run = async () =>
      request.post('dev/jobs/notification-outbox', {
        headers: await csrfHeaders(request),
      });
    expect((await run()).status()).toBe(200);
    const row = await withPrisma((prisma) =>
      prisma.notification.findUniqueOrThrow({ where: { id: queued.id } }),
    );
    expect(row).toMatchObject({ status: 'SENT', recipient: null, attempts: 1 });
    const copies = async () =>
      (await outbox(request, me.email)).filter((message) =>
        String(message.subject).includes(subject),
      );
    expect((await copies()).map((message) => message.subject)).toEqual([
      `Insurance for ${subject} expires in 9 days`,
    ]);
    // Running again sends nothing more.
    await run();
    expect(await copies()).toHaveLength(1);
  });
});

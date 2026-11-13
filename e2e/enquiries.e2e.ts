import { randomUUID } from 'node:crypto';
import { APIRequestContext, expect, test } from '@playwright/test';
import { STRICT_BASE_URL } from './support/accounts.js';
import { outbox, uniqueEmail } from './support/data.js';
import { withPrisma } from './support/db.js';

/** The operations inbox (OPERATIONS_INBOX_EMAIL's default). */
const OPERATIONS_INBOX = 'operations@flyviman.test';
const REFERENCE = /^FLY-ENQ-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/;

function enquiry(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Asha Rao',
    email: uniqueEmail('enquiry'),
    topic: 'PRIVATE_CHARTER',
    message: `Six of us to Goa in December. ${randomUUID()}`,
    ...overrides,
  };
}

function send(
  request: APIRequestContext,
  data: object,
  key: string = randomUUID(),
) {
  return request.post('enquiries', {
    headers: { 'Idempotency-Key': key },
    data,
  });
}

function rowsWith(message: string) {
  return withPrisma((prisma) =>
    prisma.enquiry.findMany({ where: { message } }),
  );
}

test.describe('POST /enquiries', () => {
  test('a visitor sends an enquiry and gets a reference, nothing else', async ({
    request,
  }) => {
    const body = enquiry({ phone: '+919876543210' });
    const response = await send(request, body);
    expect(response.status()).toBe(201);
    const { data, meta } = await response.json();
    expect(meta).toBeDefined();
    expect(Object.keys(data).sort()).toEqual(['receivedAt', 'reference']);
    expect(data.reference).toMatch(REFERENCE);
    expect(new Date(data.receivedAt).toISOString()).toBe(data.receivedAt);

    const [row] = await rowsWith(body.message);
    expect(row).toMatchObject({
      reference: data.reference,
      name: 'Asha Rao',
      email: body.email,
      phone: '+919876543210',
      topic: 'PRIVATE_CHARTER',
      handledAt: null,
    });
  });

  test('operations are emailed the enquiry', async ({ request }) => {
    const body = enquiry({ topic: 'AIRCRAFT_SALES' });
    const { data } = await (await send(request, body)).json();

    await expect
      .poll(async () =>
        (await outbox(request, OPERATIONS_INBOX)).find((message) =>
          message.subject?.includes(data.reference),
        ),
      )
      .toMatchObject({
        channel: 'EMAIL',
        subject: `New enquiry ${data.reference}: Aircraft sales`,
        body: expect.stringContaining(body.message),
      });
  });

  test('the audit record holds the topic and no contact details', async ({
    request,
  }) => {
    const body = enquiry({ topic: 'CONSULTANCY' });
    expect((await send(request, body)).status()).toBe(201);
    const [row] = await rowsWith(body.message);
    const audits = await withPrisma((prisma) =>
      prisma.auditLog.findMany({
        where: { entityType: 'Enquiry', entityId: row.id },
      }),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'enquiry.create',
      actorId: null,
      after: { topic: 'CONSULTANCY' },
      before: null,
      reason: null,
    });
  });

  test('a phone number alone is enough', async ({ request }) => {
    const response = await send(
      request,
      enquiry({ email: undefined, phone: '+919812345678' }),
    );
    expect(response.status()).toBe(201);
  });

  test('without an email address or phone number it is refused on email', async ({
    request,
  }) => {
    const body = enquiry({ email: undefined });
    const response = await send(request, body);
    expect(response.status()).toBe(400);
    const { error } = await response.json();
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.details).toContainEqual(
      expect.objectContaining({ field: 'email' }),
    );
    expect(await rowsWith(body.message)).toHaveLength(0);
  });

  for (const [what, overrides, field] of [
    ['a short message', { message: 'Hi there' }, 'message'],
    ['an unknown topic', { topic: 'SPACE_TOURISM' }, 'topic'],
    ['an empty name', { name: '   ' }, 'name'],
    // A name that adds lines of its own to the staff email.
    [
      'a name over several lines',
      { name: 'Asha\nEmail: someone@else.test' },
      'name',
    ],
    ['a malformed phone number', { phone: '98765 43210' }, 'phone'],
    ['a malformed email address', { email: 'not-an-email' }, 'email'],
    ['an unknown property', { budget: 100000 }, 'budget'],
  ] as const) {
    test(`refuses ${what}`, async ({ request }) => {
      const response = await send(request, enquiry(overrides));
      expect(response.status()).toBe(400);
      const { error } = await response.json();
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.details).toContainEqual(expect.objectContaining({ field }));
    });
  }

  test('strips hidden text-direction characters from the message', async ({
    request,
  }) => {
    const marker = randomUUID();
    const body = enquiry({ message: `Six to Goa \u202Ein December ${marker}` });
    expect((await send(request, body)).status()).toBe(201);

    const rows = await withPrisma((prisma) =>
      prisma.enquiry.findMany({ where: { message: { contains: marker } } }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toBe(`Six to Goa in December ${marker}`);
  });

  test('once emailed, the stored copy of the contact details is cleared', async ({
    request,
  }) => {
    const body = enquiry();
    const { data } = await (await send(request, body)).json();

    await expect
      .poll(() =>
        withPrisma((prisma) =>
          prisma.notification.findFirst({
            where: {
              templateKey: 'enquiry.received',
              status: 'SENT',
              createdAt: { gte: new Date(data.receivedAt) },
              payload: { equals: {} },
            },
          }),
        ),
      )
      .not.toBeNull();
    const leftovers = await withPrisma((prisma) =>
      prisma.notification.findMany({
        where: {
          templateKey: 'enquiry.received',
          payload: { path: ['message'], equals: body.message },
        },
      }),
    );
    expect(leftovers).toHaveLength(0);
  });

  test('needs an Idempotency-Key', async ({ request }) => {
    const body = enquiry();
    const response = await request.post('enquiries', { data: body });
    expect(response.status()).toBe(400);
    const { error } = await response.json();
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.details).toContainEqual(
      expect.objectContaining({ field: 'Idempotency-Key' }),
    );
    expect(await rowsWith(body.message)).toHaveLength(0);
  });

  test('a repeat with the same key and body creates one enquiry and returns the first answer', async ({
    request,
  }) => {
    const body = enquiry();
    const key = randomUUID();
    const first = await send(request, body, key);
    expect(first.status()).toBe(201);
    const second = await send(request, body, key);
    expect(second.status()).toBe(201);
    expect(second.headers()['idempotent-replayed']).toBe('true');
    expect((await second.json()).data).toEqual((await first.json()).data);
    expect(await rowsWith(body.message)).toHaveLength(1);
  });

  test('the same key with a different body is refused', async ({ request }) => {
    const key = randomUUID();
    const body = enquiry();
    expect((await send(request, body, key)).status()).toBe(201);
    const other = enquiry();
    const second = await send(request, other, key);
    expect(second.status()).toBe(409);
    expect((await second.json()).error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await rowsWith(other.message)).toHaveLength(0);
  });
});

test.describe('POST /enquiries rate limit', () => {
  test('one address can send 5 enquiries in 10 minutes', async ({
    playwright,
  }) => {
    // The strict server runs the real limits. Its counter lives as long as
    // the server, so an earlier run within 10 minutes may have used some.
    const request = await playwright.request.newContext({
      baseURL: STRICT_BASE_URL,
    });
    const statuses: number[] = [];
    let blocked;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await send(request, enquiry());
      statuses.push(response.status());
      if (response.status() === 429) {
        blocked = response;
        break;
      }
    }
    expect(
      statuses.filter((status) => status === 201).length,
    ).toBeLessThanOrEqual(5);
    expect(blocked, `statuses: ${statuses.join(', ')}`).toBeDefined();
    expect((await blocked!.json()).error.code).toBe('RATE_LIMITED');
    expect(Number(blocked!.headers()['retry-after'])).toBeGreaterThan(0);
    await request.dispose();
  });
});

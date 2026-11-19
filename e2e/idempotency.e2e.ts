import { randomUUID } from 'node:crypto';
import { APIRequestContext, expect, test } from '@playwright/test';
import { uniqueEmail } from './support/data.js';
import { withPrisma } from './support/db.js';

// The durable idempotency keys (src/common/idempotency), exercised through
// POST /enquiries, the route that uses them today.

const HOUR = 3600 * 1000;

function enquiry(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Asha Rao',
    email: uniqueEmail('idempotency'),
    topic: 'PRIVATE_CHARTER',
    message: `Six of us to Goa in December. ${randomUUID()}`,
    ...overrides,
  };
}

function send(request: APIRequestContext, data: object, key: string) {
  return request.post('enquiries', {
    headers: { 'Idempotency-Key': key },
    data,
  });
}

function enquiriesWith(message: string) {
  return withPrisma((prisma) =>
    prisma.enquiry.findMany({ where: { message } }),
  );
}

function keyRow(key: string) {
  return withPrisma((prisma) =>
    prisma.idempotencyKey.findMany({ where: { key } }),
  );
}

/** Puts the key's row into a state a crash or a slow request would leave. */
function setRow(key: string, data: Record<string, unknown>) {
  return withPrisma((prisma) =>
    prisma.idempotencyKey.updateMany({ where: { key }, data }),
  );
}

test.describe('Idempotency-Key', () => {
  test('concurrent duplicates create one enquiry, and every success is the same answer', async ({
    request,
  }) => {
    const body = enquiry();
    const key = randomUUID();
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => send(request, body, key)),
    );
    const statuses = responses.map((response) => response.status());
    expect(statuses.every((status) => status === 201 || status === 409)).toBe(
      true,
    );
    const successes = responses.filter((response) => response.status() === 201);
    expect(successes.length).toBeGreaterThanOrEqual(1);
    const answers = await Promise.all(
      successes.map(async (response) => (await response.json()).data),
    );
    for (const answer of answers) expect(answer).toEqual(answers[0]);
    for (const response of responses.filter((r) => r.status() === 409)) {
      expect((await response.json()).error.code).toBe('IDEMPOTENCY_CONFLICT');
    }

    expect(await enquiriesWith(body.message)).toHaveLength(1);
    const rows = await keyRow(key);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      scope: 'anonymous:POST:/api/v1/enquiries',
      status: 'COMPLETED',
      responseStatus: 201,
      responseBody: answers[0],
    });

    // Once finished, a repeat gets the stored answer from the database.
    const replay = await send(request, body, key);
    expect(replay.status()).toBe(201);
    expect(replay.headers()['idempotent-replayed']).toBe('true');
    expect((await replay.json()).data).toEqual(answers[0]);
    expect(await enquiriesWith(body.message)).toHaveLength(1);
  });

  test('a request refused before it changed anything frees its key', async ({
    request,
  }) => {
    const key = randomUUID();
    const refused = await send(request, enquiry({ message: 'Hi' }), key);
    expect(refused.status()).toBe(400);
    expect(await keyRow(key)).toHaveLength(0);

    const body = enquiry();
    expect((await send(request, body, key)).status()).toBe(201);
    expect(await enquiriesWith(body.message)).toHaveLength(1);
  });

  test('a request that failed after its change committed is never replayed as a success', async ({
    request,
  }) => {
    const body = enquiry();
    const key = randomUUID();
    expect((await send(request, body, key)).status()).toBe(201);
    await setRow(key, { status: 'FAILED', lockedUntil: new Date(0) });

    const repeat = await send(request, body, key);
    expect(repeat.status()).toBe(409);
    const { error } = await repeat.json();
    expect(error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(error.message).toMatch(/may have taken effect/);
    expect(await enquiriesWith(body.message)).toHaveLength(1);
  });

  test('a request that committed and then stopped is waited for, then reported as unknown', async ({
    request,
  }) => {
    const body = enquiry();
    const key = randomUUID();
    expect((await send(request, body, key)).status()).toBe(201);

    await setRow(key, {
      status: 'COMMITTED',
      lockedUntil: new Date(Date.now() + HOUR),
    });
    const during = await send(request, body, key);
    expect(during.status()).toBe(409);
    expect(during.headers()['retry-after']).toBe('2');

    await setRow(key, { lockedUntil: new Date(Date.now() - 1000) });
    const after = await send(request, body, key);
    expect(after.status()).toBe(409);
    expect((await after.json()).error.message).toMatch(/may have taken effect/);
    expect(await enquiriesWith(body.message)).toHaveLength(1);
  });

  test('a request that died before committing is taken over once its lock runs out', async ({
    request,
  }) => {
    // A first attempt holds the key and never commits (the process died).
    const body = enquiry();
    const key = randomUUID();
    const scope = 'anonymous:POST:/api/v1/enquiries';
    const hash = await (async () => {
      const probe = randomUUID();
      // The stored hash of this body, taken from a request with another key.
      expect((await send(request, body, probe)).status()).toBe(201);
      const [row] = await keyRow(probe);
      return row.requestHash;
    })();
    const deadOwner = randomUUID();
    await withPrisma((prisma) =>
      prisma.idempotencyKey.create({
        data: {
          scope,
          key,
          requestHash: hash,
          status: 'IN_PROGRESS',
          ownerToken: deadOwner,
          lockedUntil: new Date(Date.now() + HOUR),
          expiresAt: new Date(Date.now() + 24 * HOUR),
        },
      }),
    );

    const held = await send(request, body, key);
    expect(held.status()).toBe(409);
    expect(held.headers()['retry-after']).toBe('2');

    await setRow(key, { lockedUntil: new Date(Date.now() - 1000) });
    const retry = await send(request, body, key);
    expect(retry.status()).toBe(201);
    const [row] = await keyRow(key);
    expect(row.status).toBe('COMPLETED');
    expect(row.ownerToken).not.toBe(deadOwner);
    // The probe's enquiry and the retry's: the dead attempt made none.
    expect(await enquiriesWith(body.message)).toHaveLength(2);
  });

  test('a different body is refused until the key expires after 24 hours', async ({
    request,
  }) => {
    const key = randomUUID();
    expect((await send(request, enquiry(), key)).status()).toBe(201);
    const other = enquiry();
    expect((await send(request, other, key)).status()).toBe(409);

    await setRow(key, { expiresAt: new Date(Date.now() - 1000) });
    const reused = await send(request, other, key);
    expect(reused.status()).toBe(201);
    expect(reused.headers()['idempotent-replayed']).toBeUndefined();
    expect(await enquiriesWith(other.message)).toHaveLength(1);
  });
});

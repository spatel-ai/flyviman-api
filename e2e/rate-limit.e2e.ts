import { expect, test } from '@playwright/test';
import { uniqueEmail } from './support/data.js';
import { ACCOUNTS, STRICT_BASE_URL } from './support/accounts.js';

test('sign-in attempts are rate limited per address', async ({
  playwright,
}) => {
  const request = await playwright.request.newContext({
    baseURL: STRICT_BASE_URL,
  });

  // The limit is 5 a minute. A sixth attempt inside the window is refused;
  // earlier ones may be too if this test ran within the last minute.
  const statuses: number[] = [];
  let blocked;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await request.post('auth/login', {
      data: { email: uniqueEmail('nobody'), password: 'not-the-password' },
    });
    statuses.push(response.status());
    if (response.status() === 429) blocked = response;
  }

  expect(
    statuses.filter((status) => status === 401).length,
  ).toBeLessThanOrEqual(5);
  expect(blocked, `statuses: ${statuses.join(', ')}`).toBeDefined();
  expect((await blocked!.json()).error.code).toBe('RATE_LIMITED');
  expect(Number(blocked!.headers()['retry-after'])).toBeGreaterThan(0);

  await request.dispose();
});

test('responses carry the standard rate limit headers', async ({
  playwright,
}) => {
  const request = await playwright.request.newContext({
    baseURL: STRICT_BASE_URL,
  });
  const headers = (await request.get('health')).headers();
  expect(headers['ratelimit-limit']).toBe('100');
  expect(Number(headers['ratelimit-remaining'])).toBeLessThan(100);
  await request.dispose();
});

test('keeping a session alive is counted per session, not per address', async ({
  playwright,
}) => {
  // The web server refreshes sessions for every user from one address. Each
  // session has its own allowance, so one busy session cannot use up another's.
  const sessions = await Promise.all(
    [0, 1].map(() =>
      playwright.request.newContext({ baseURL: STRICT_BASE_URL }),
    ),
  );
  for (const session of sessions) {
    const login = await session.post('auth/login', {
      data: { email: ACCOUNTS.ops.email, password: ACCOUNTS.ops.password },
    });
    expect(login.status()).toBe(200);
  }

  const [busy, other] = sessions;
  const statuses: number[] = [];
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const csrf =
      (await busy.storageState()).cookies.find((c) => c.name === 'csrf_token')
        ?.value ?? '';
    const response = await busy.post('auth/refresh', {
      headers: { 'X-CSRF-Token': csrf },
    });
    statuses.push(response.status());
  }
  // Each rotation is a new refresh token with its own counter.
  expect(statuses).toEqual(Array(7).fill(204));

  const csrf =
    (await other.storageState()).cookies.find((c) => c.name === 'csrf_token')
      ?.value ?? '';
  expect(
    (
      await other.post('auth/refresh', { headers: { 'X-CSRF-Token': csrf } })
    ).status(),
  ).toBe(204);
  for (const session of sessions) await session.dispose();
});

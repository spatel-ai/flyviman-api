import { APIRequestContext, expect } from '@playwright/test';
import { AccountName, ACCOUNTS } from './accounts.js';

/** Signs the request context in. Its cookie jar then carries the session. */
export async function signIn(
  request: APIRequestContext,
  account: AccountName,
): Promise<void> {
  const { email, password } = ACCOUNTS[account];
  // Signing in again on a context that already holds a session is a
  // state-changing request with a session cookie, so it needs the CSRF header.
  const response = await request.post('auth/login', {
    headers: await csrfHeaders(request),
    data: { email, password },
  });
  expect(response.status(), `sign in as ${account}`).toBe(200);
}

export async function cookie(
  request: APIRequestContext,
  name: string,
): Promise<string | undefined> {
  const state = await request.storageState();
  return state.cookies.find((entry) => entry.name === name)?.value;
}

/** Headers a state-changing request needs once a session exists. */
export async function csrfHeaders(
  request: APIRequestContext,
): Promise<Record<string, string>> {
  return { 'X-CSRF-Token': (await cookie(request, 'csrf_token')) ?? '' };
}

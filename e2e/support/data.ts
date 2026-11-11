import { randomUUID } from 'node:crypto';
import { APIRequestContext, expect } from '@playwright/test';

/** A password that passes the policy. */
export const PASSWORD = 'correct horse battery staple';

export function uniqueEmail(prefix = 'user'): string {
  return `${prefix}-${randomUUID()}@flyviman.test`;
}

export function uniquePhone(): string {
  // +91 followed by ten digits, unique enough for a test run.
  const digits = BigInt(`0x${randomUUID().replaceAll('-', '').slice(0, 12)}`)
    .toString()
    .padStart(10, '0')
    .slice(-9);
  return `+919${digits}`;
}

interface OutboxMessage {
  channel: string;
  to: string;
  subject?: string;
  body: string;
}

/** Messages the messaging mock "sent" to an address, newest first. */
export async function outbox(
  request: APIRequestContext,
  to: string,
): Promise<OutboxMessage[]> {
  const response = await request.get('dev/outbox', { params: { to } });
  expect(response.status()).toBe(200);
  return (await response.json()).data;
}

/** The most recent six-digit code sent to an address. */
export async function latestCode(
  request: APIRequestContext,
  to: string,
): Promise<string> {
  const messages = await outbox(request, to);
  const code = messages
    .map((message) => /\b(\d{6})\b/.exec(message.body)?.[1])
    .find(Boolean);
  expect(code, `a code was sent to ${to}`).toBeTruthy();
  return code!;
}

/** The token from the most recent emailed password link. */
export async function latestLinkToken(
  request: APIRequestContext,
  to: string,
): Promise<string> {
  const messages = await outbox(request, to);
  const token = messages
    .map((message) => /[?&]token=([\w-]+)/.exec(message.body)?.[1])
    .find(Boolean);
  expect(token, `a link was sent to ${to}`).toBeTruthy();
  return decodeURIComponent(token!);
}

/** Completes an open verification attempt with the code sent to `to`. */
export async function verify(
  request: APIRequestContext,
  verificationId: string,
  to: string,
  route: 'auth/email/verify' | 'auth/otp/verify' = 'auth/email/verify',
) {
  const response = await request.post(route, {
    data: { verificationId, code: await latestCode(request, to) },
  });
  expect(response.status(), `verify ${to}`).toBe(200);
  return (await response.json()).data as { id: string; role: string };
}

/** Registers a customer by email, verifies the code, and leaves `request` signed in. */
export async function registerCustomer(
  request: APIRequestContext,
  overrides: { email?: string; firstName?: string } = {},
): Promise<{ email: string; id: string }> {
  const email = overrides.email ?? uniqueEmail('customer');
  const register = await request.post('auth/register', {
    data: {
      firstName: overrides.firstName ?? 'Asha',
      lastName: 'Rao',
      email,
      password: PASSWORD,
      acceptTerms: true,
    },
  });
  expect(register.status()).toBe(202);
  const { verificationId } = (await register.json()).data;
  const user = await verify(request, verificationId, email);
  return { email, id: user.id };
}

/** Registers an operator, verifies its administrator, and leaves `request` signed in. */
export async function registerOperator(
  request: APIRequestContext,
): Promise<{ email: string; legalName: string }> {
  const email = uniqueEmail('operator');
  const legalName = `Skyline Aviation ${randomUUID().slice(0, 8)}`;
  const register = await request.post('operator/register', {
    data: {
      legalName,
      contactName: 'Meera Nair',
      email,
      password: PASSWORD,
      acceptTerms: true,
    },
  });
  expect(register.status()).toBe(202);
  const { verificationId } = (await register.json()).data;
  await verify(request, verificationId, email);
  return { email, legalName };
}

const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');

/** Uploads a small PDF through the signed URL and returns its file ID. */
export async function uploadPdf(
  request: APIRequestContext,
  csrf: Record<string, string>,
  fileName = 'certificate.pdf',
): Promise<string> {
  const presign = await request.post('uploads/presign', {
    headers: csrf,
    data: {
      purpose: 'OPERATOR_DOCUMENT',
      fileName,
      contentType: 'application/pdf',
      sizeBytes: PDF.length,
    },
  });
  expect(presign.status()).toBe(201);
  const { fileId, upload } = (await presign.json()).data;
  const put = await request.fetch(upload.url, {
    method: upload.method,
    headers: upload.headers,
    data: PDF,
  });
  expect(put.status()).toBe(200);
  return fileId;
}

export const PDF_BYTES = PDF;

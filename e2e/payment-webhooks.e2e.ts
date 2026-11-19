import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import {
  MOCK_EVENT_ID_HEADER,
  MOCK_PAYMENT_WEBHOOK_SECRET,
  MOCK_SIGNATURE_HEADER,
} from '../src/integrations/payment/mock-payment-gateway.provider.js';
import { hmacSha256Hex } from '../src/integrations/payment/payment-signature.js';

const PATH = 'webhooks/payments/mock';

/**
 * A captured-payment event in Razorpay's shape, deliberately not in
 * JSON.stringify's own spacing: the signature must be checked over the
 * bytes as sent, never over a re-serialised body.
 */
function capturedBody(amount = 1_250_000): string {
  return `{ "entity": "event",  "event": "payment.captured",
  "payload": { "payment": { "entity": {
    "id": "pay_e2e_${randomUUID()}", "order_id": "order_e2e_1",
    "amount": ${amount}, "currency": "INR", "status": "captured" } } } }`;
}

function headersFor(
  body: string,
  eventId = `evt_e2e_${randomUUID()}`,
): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    [MOCK_SIGNATURE_HEADER]: hmacSha256Hex(MOCK_PAYMENT_WEBHOOK_SECRET, body),
    [MOCK_EVENT_ID_HEADER]: eventId,
  };
}

test.describe('POST /webhooks/payments/:provider', () => {
  test('a correctly signed event is acknowledged, with no session, CSRF token or rate limit', async ({
    request,
  }) => {
    const body = capturedBody();
    const response = await request.post(PATH, {
      data: body,
      headers: {
        ...headersFor(body),
        // A gateway is another site; the CSRF origin check must not apply.
        Origin: 'https://api.razorpay.com',
      },
    });

    expect(response.status()).toBe(200);
    expect((await response.json()).data).toEqual({ received: true });
    expect(response.headers()['ratelimit-limit']).toBeUndefined();
  });

  test('the signature covers the exact bytes: the same event re-spaced is refused', async ({
    request,
  }) => {
    const body = capturedBody();
    const respaced = JSON.stringify(JSON.parse(body));

    const response = await request.post(PATH, {
      data: respaced,
      headers: headersFor(body),
    });

    expect(response.status()).toBe(400);
    expect((await response.json()).error.code).toBe(
      'WEBHOOK_SIGNATURE_INVALID',
    );
  });

  test('a tampered amount is refused', async ({ request }) => {
    const body = capturedBody();
    const response = await request.post(PATH, {
      data: body.replace('1250000', '100'),
      headers: headersFor(body),
    });

    expect(response.status()).toBe(400);
    expect((await response.json()).error.code).toBe(
      'WEBHOOK_SIGNATURE_INVALID',
    );
  });

  test('a missing or wrong-secret signature is refused', async ({
    request,
  }) => {
    const body = capturedBody();
    const { [MOCK_SIGNATURE_HEADER]: _signature, ...unsigned } =
      headersFor(body);

    for (const headers of [
      unsigned,
      { ...unsigned, [MOCK_SIGNATURE_HEADER]: hmacSha256Hex('guess', body) },
    ]) {
      const response = await request.post(PATH, { data: body, headers });
      expect(response.status()).toBe(400);
      expect((await response.json()).error.code).toBe(
        'WEBHOOK_SIGNATURE_INVALID',
      );
    }
  });

  test('a duplicate delivery of the same event is acknowledged again', async ({
    request,
  }) => {
    const body = capturedBody();
    const headers = headersFor(body);

    for (let delivery = 0; delivery < 2; delivery += 1) {
      const response = await request.post(PATH, { data: body, headers });
      expect(response.status()).toBe(200);
      expect((await response.json()).data).toEqual({ received: true });
    }
  });

  test('a signed body that is not a well-formed event is refused', async ({
    request,
  }) => {
    const body = '{"event": "payment.captured", "payload": {}}';
    const response = await request.post(PATH, {
      data: body,
      headers: headersFor(body),
    });

    expect(response.status()).toBe(400);
    expect((await response.json()).error.code).toBe('VALIDATION_ERROR');
  });

  test('the body is kept raw whatever its declared type', async ({
    request,
  }) => {
    const body = capturedBody();
    const response = await request.post(PATH, {
      data: body,
      headers: { ...headersFor(body), 'Content-Type': 'text/plain' },
    });

    expect(response.status()).toBe(200);
  });

  test('a gateway other than the configured one does not exist', async ({
    request,
  }) => {
    const body = capturedBody();
    const response = await request.post('webhooks/payments/razorpay', {
      data: body,
      headers: headersFor(body),
    });

    expect(response.status()).toBe(404);
    expect((await response.json()).error.code).toBe('NOT_FOUND');
  });
});

test.describe('raw webhook bodies leave other routes alone', () => {
  test('a JSON body to another route is still parsed and validated', async ({
    request,
  }) => {
    const response = await request.post('auth/login', {
      data: { email: `nobody-${randomUUID()}@example.com`, password: 'wrong' },
    });

    expect(response.status()).toBe(401);
    expect((await response.json()).error.code).toBe('AUTH_INVALID_CREDENTIALS');
  });
});

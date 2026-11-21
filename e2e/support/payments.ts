import { randomUUID } from 'node:crypto';
import { APIRequestContext, expect } from '@playwright/test';
import {
  MOCK_EVENT_ID_HEADER,
  MOCK_PAYMENT_WEBHOOK_SECRET,
  MOCK_SIGNATURE_HEADER,
} from '../../src/integrations/payment/mock-payment-gateway.provider.js';
import { hmacSha256Hex } from '../../src/integrations/payment/payment-signature.js';
import { registerCustomer } from './data.js';
import { withPrisma } from './db.js';
import { listedJet, searchFor } from './pricing.js';
import { csrfHeaders } from './session.js';

/**
 * Payment-order and webhook helpers shared by the payment, receipt and
 * webhook e2e files (moved from `payments.e2e.ts`, behaviour unchanged).
 */

export type Contexts = Parameters<typeof listedJet>[0];
export type Model = 'A_INSTANT' | 'B_OPERATOR_CONFIRMED' | 'C_DEPOSIT';

/**
 * A booking request from a real search, moved by hand to where quotes
 * (W3-1) will bring it: `AWAITING_PAYMENT` with a `CONFIRMED` price.
 */
export async function bookingAwaitingPayment(
  contexts: Contexts,
  model: Model = 'B_OPERATOR_CONFIRMED',
) {
  const { request } = contexts;
  const trip = await listedJet(contexts);
  const rate = await request.put(
    `operator/aircraft/${trip.aircraftId}/pricing`,
    {
      headers: await csrfHeaders(request),
      data: {
        hourlyRateMinor: 18_000_000,
        taxInclusive: false,
        commissionInclusive: false,
        minBillableHours: null,
      },
    },
  );
  expect(rate.status()).toBe(200);
  const searched = await searchFor(request, trip);
  const customer = await contexts.playwright.request.newContext({
    baseURL: contexts.baseURL,
  });
  await registerCustomer(customer);
  const booked = await customer.post('bookings', {
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
  expect(booked.status()).toBe(201);
  const reference = (await booked.json()).data.reference as string;
  await setBooking(reference, {
    status: 'AWAITING_PAYMENT',
    priceType: 'CONFIRMED',
    operatorAcceptedAt: new Date(),
    paymentModel: model,
  });
  return {
    customer,
    reference,
    totalMinor: searched.result.price.amountMinor as number,
    trip,
    searched,
  };
}

export function setBooking(
  reference: string,
  data: Record<string, unknown>,
): Promise<unknown> {
  return withPrisma((prisma) =>
    prisma.booking.update({ where: { reference }, data }),
  );
}

export async function pay(
  customer: APIRequestContext,
  reference: string,
  expectedAmountMinor: number,
  key: string = randomUUID(),
) {
  return customer.post(`bookings/${reference}/payments`, {
    headers: { ...(await csrfHeaders(customer)), 'Idempotency-Key': key },
    data: { expectedAmountMinor, currency: 'INR' },
  });
}

export async function created(
  customer: APIRequestContext,
  reference: string,
  amountMinor: number,
) {
  const response = await pay(customer, reference, amountMinor);
  expect(response.status()).toBe(201);
  return (await response.json()).data as {
    reference: string;
    status: string;
    purpose: string;
    price: { priceType: string; amountMinor: number; currency: string };
    checkout: { provider: string; keyId: string; orderId: string };
  };
}

/** A signed payment notice in Razorpay's shape, as the gateway posts it. */
export function notice(
  event: 'payment.captured' | 'payment.failed',
  order: { orderId: string; amountMinor: number },
  options: { paymentId?: string; eventId?: string } = {},
) {
  const body = JSON.stringify({
    entity: 'event',
    event,
    payload: {
      payment: {
        entity: {
          id: options.paymentId ?? `pay_e2e_${randomUUID()}`,
          order_id: order.orderId,
          amount: order.amountMinor,
          currency: 'INR',
          status: event === 'payment.captured' ? 'captured' : 'failed',
          // Sent by the gateway, never stored (rule 10).
          email: 'payer@example.com',
          card: { last4: '4242', network: 'Visa' },
        },
      },
    },
  });
  return {
    body,
    eventId: options.eventId ?? `evt_e2e_${randomUUID()}`,
  };
}

export function deliver(
  request: APIRequestContext,
  webhook: { body: string; eventId: string },
  secret = MOCK_PAYMENT_WEBHOOK_SECRET,
) {
  return request.post('webhooks/payments/mock', {
    data: webhook.body,
    headers: {
      'Content-Type': 'application/json',
      [MOCK_SIGNATURE_HEADER]: hmacSha256Hex(secret, webhook.body),
      [MOCK_EVENT_ID_HEADER]: webhook.eventId,
    },
  });
}

export async function bookingOf(
  customer: APIRequestContext,
  reference: string,
) {
  const response = await customer.get(`bookings/${reference}`);
  expect(response.status()).toBe(200);
  return (await response.json()).data as {
    status: string;
    paymentStatus: string;
  };
}

export function paymentRow(reference: string) {
  return withPrisma((prisma) =>
    prisma.payment.findUniqueOrThrow({ where: { reference } }),
  );
}

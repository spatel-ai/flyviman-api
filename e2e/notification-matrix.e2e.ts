import { randomUUID } from 'node:crypto';
import { APIRequestContext, expect, test } from '@playwright/test';
import {
  outbox,
  PASSWORD,
  registerCustomer,
  uniqueEmail,
  uniquePhone,
  latestLinkToken,
} from './support/data.js';
import { withPrisma } from './support/db.js';
import { listedJet, searchFor } from './support/pricing.js';
import { csrfHeaders, signIn } from './support/session.js';

/**
 * The notification matrix (M10, W4-8) end to end through the mock outbox:
 * who is told of a booking request, a change request and an air ambulance
 * request, on which channels, with which link.
 */

type Contexts = Parameters<typeof listedJet>[0];

interface Inbox {
  templateKey: string;
  href: string | null;
  title: string;
  body: string;
}

/** Sends what is queued now rather than waiting for the dispatcher. */
async function dispatch(request: APIRequestContext) {
  // One run sends a batch of 20 (OUTBOX_BATCH): repeat until the queue is
  // drained, so messages queued by other tests do not crowd ours out.
  for (let run = 0; run < 20; run += 1) {
    const response = await request.post('dev/jobs/notification-outbox', {
      headers: await csrfHeaders(request),
    });
    expect(response.status()).toBe(200);
    if ((await response.json()).data.sent < 20) return;
  }
}

async function inApp(request: APIRequestContext): Promise<Inbox[]> {
  const response = await request.get('me/notifications', {
    params: { pageSize: 100 },
  });
  expect(response.status()).toBe(200);
  return (await response.json()).data;
}

async function emailOf(request: APIRequestContext): Promise<string> {
  return (await (await request.get('me')).json()).data.email as string;
}

/** A customer with a verified phone number, so text channels apply. */
async function customerWithPhone(contexts: Contexts) {
  const customer = await contexts.playwright.request.newContext({
    baseURL: contexts.baseURL,
  });
  const { email, id } = await registerCustomer(customer);
  const phone = uniquePhone();
  await withPrisma((prisma) =>
    prisma.user.update({
      where: { id },
      data: { phone, phoneVerifiedAt: new Date() },
    }),
  );
  return { customer, email, phone };
}

/** A request on a fresh priced jet (operator on `request`) by `customer`. */
async function requestedBy(
  contexts: Contexts,
  customer: APIRequestContext,
  trip?: Awaited<ReturnType<typeof listedJet>>,
) {
  const { request } = contexts;
  trip ??= await listedJet(contexts);
  const priced = await request.put(
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
  expect(priced.status()).toBe(200);
  const searched = await searchFor(request, trip);
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
  return { trip, reference: (await created.json()).data.reference as string };
}

/** Operator staff of the operator on `admin`, signed in on their own context. */
async function staffMember(
  contexts: Contexts,
  permissions: { capabilities: string[]; allAircraft: boolean },
) {
  const email = uniqueEmail('staff');
  const invited = await contexts.request.post('operator/staff', {
    headers: await csrfHeaders(contexts.request),
    data: { email, aircraftIds: [], ...permissions },
  });
  expect(invited.status()).toBe(201);
  const staff = await contexts.playwright.request.newContext({
    baseURL: contexts.baseURL,
  });
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
  return { staff, email };
}

test.describe('notification matrix', () => {
  test('a new request tells the operator team that handles bookings, and a price confirmation tells the customer on every channel', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const trip = await listedJet(contexts);
    const handler = await staffMember(contexts, {
      capabilities: ['MANAGE_BOOKINGS'],
      allAircraft: true,
    });
    const other = await staffMember(contexts, {
      capabilities: ['MANAGE_AIRCRAFT'],
      allAircraft: true,
    });
    const { customer, email, phone } = await customerWithPhone(contexts);
    const { reference } = await requestedBy(contexts, customer, trip);
    await dispatch(request);

    // The administrator and the booking handler are told, in-app and by email.
    for (const member of [request, handler.staff]) {
      const item = (await inApp(member)).find(
        (n) => n.templateKey === 'booking.requested',
      );
      expect(item, 'in-app message').toBeTruthy();
      expect(item!.href).toBe(`/operator/requests/${reference}`);
      expect(item!.title).toContain(reference);
      const mail = (await outbox(request, await emailOf(member))).find(
        (m) => m.channel === 'EMAIL' && m.body.includes(reference),
      );
      expect(mail, 'email').toBeTruthy();
      expect(mail!.body).toContain(`/operator/requests/${reference}`);
    }
    // Staff without the capability are not.
    expect(
      (await inApp(other.staff)).some(
        (n) => n.templateKey === 'booking.requested',
      ),
    ).toBe(false);

    // The operator accepts: the customer is told over all four channels.
    const accepted = await request.post(
      `operator/booking-requests/${reference}/accept`,
      {
        headers: {
          ...(await csrfHeaders(request)),
          'Idempotency-Key': randomUUID(),
        },
      },
    );
    expect(accepted.status()).toBe(200);
    await dispatch(request);

    const mine = (await inApp(customer)).find(
      (n) => n.templateKey === 'booking.price_confirmed',
    );
    expect(mine?.href).toBe(`/account/trips/${reference}`);
    const messages = [
      ...(await outbox(request, email)),
      ...(await outbox(request, phone)),
    ].filter((m) => m.body.includes(reference));
    const channels = messages.map((m) => m.channel).sort();
    expect(channels).toEqual(['EMAIL', 'SMS', 'WHATSAPP']);
    for (const message of messages.filter((m) => m.channel !== 'EMAIL')) {
      // A short text with the reference and link: no price, no passenger.
      expect(message.body).toContain(`/account/trips/${reference}`);
      expect(message.body).toContain('not confirmed until Flyviman tells');
      expect(message.body).not.toMatch(/₹|INR|\d{4,}\.\d\d/);
    }
  });

  test('a change request tells the operator, and the decision tells the customer in words that cannot carry the note', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { customer, email } = await customerWithPhone(contexts);
    const { reference } = await requestedBy(contexts, customer);
    const asked = await customer.post(`bookings/${reference}/change-requests`, {
      headers: await csrfHeaders(customer),
      data: { details: 'A private reason <b>about the passenger</b>' },
    });
    expect(asked.status()).toBe(201);
    const id = (await asked.json()).data.id as string;
    await dispatch(request);

    const told = (await inApp(request)).find(
      (n) => n.templateKey === 'booking.change_requested',
    );
    expect(told?.href).toBe(`/operator/requests/${reference}`);
    // The customer's words stay on the request, not in the message.
    expect(JSON.stringify(told)).not.toContain('private reason');

    const decided = await request.post(
      `operator/change-requests/${id}/decide`,
      {
        headers: await csrfHeaders(request),
        data: { decision: 'REJECTED', note: 'Secret operator <i>note</i>' },
      },
    );
    expect(decided.status()).toBe(200);
    await dispatch(request);

    const item = (await inApp(customer)).find(
      (n) => n.templateKey === 'booking.change_decided',
    );
    expect(item?.title).toBe(
      `Your change request for ${reference} was declined`,
    );
    const mail = (await outbox(request, email)).find((m) =>
      m.body.includes('change request'),
    );
    expect(mail?.body).not.toContain('Secret operator');
  });

  test('a new air ambulance request alerts operations with the reference only, and a cancellation tells the customer with the emergency notice', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { customer, phone } = await customerWithPhone({
      request,
      playwright,
      baseURL,
    });
    const places = await customer.get('locations', { params: { pageSize: 2 } });
    const [origin, destination] = (await places.json()).data as {
      id: string;
    }[];
    const created = await customer.post('air-ambulance/requests', {
      headers: {
        ...(await csrfHeaders(customer)),
        'Idempotency-Key': randomUUID(),
      },
      data: {
        contactName: 'Asha Rao',
        contactPhone: '+919800000001',
        originLocationId: origin.id,
        destinationLocationId: destination.id,
        pickupAddress: 'City Hospital, Ward 4',
        preferredAt: new Date(Date.now() + 86_400_000).toISOString(),
        patientCount: 1,
        accompanyingPersons: 0,
        medical: {
          patientCondition: 'Post-operative cardiac patient, stable',
          mobility: 'NON_AMBULATORY',
          stretcherRequired: true,
          oxygenRequired: true,
        },
      },
    });
    expect(created.status()).toBe(201);
    const reference = (await created.json()).data.reference as string;
    await dispatch(request);

    const ops = await playwright.request.newContext({ baseURL });
    await signIn(ops, 'ops');
    const item = (await inApp(ops)).find((n) => n.body.includes(reference));
    expect(item?.templateKey).toBe('air_ambulance.received');
    expect(item?.href).toBe(`/admin/air-ambulance/${reference}`);
    const mail = (await outbox(request, 'operations@flyviman.test')).find((m) =>
      m.body.includes(reference),
    );
    expect(mail, 'the operations inbox is emailed').toBeTruthy();
    expect(`${mail!.subject} ${mail!.body}`).not.toMatch(
      /cardiac|City Hospital|Asha|9800000001/,
    );

    const cancelled = await customer.post(
      `air-ambulance/requests/${reference}/cancel`,
      { headers: await csrfHeaders(customer) },
    );
    expect(cancelled.status()).toBe(200);
    await dispatch(request);

    const own = (await inApp(customer)).find(
      (n) => n.templateKey === 'air_ambulance.cancelled',
    );
    expect(own?.href).toBe(`/air-ambulance/requests/${reference}`);
    expect(own?.body).toMatch(/emergency/i);
    const text = (await outbox(request, phone)).filter((m) =>
      m.body.includes(reference),
    );
    expect(text.map((m) => m.channel).sort()).toEqual(['SMS', 'WHATSAPP']);
  });
});

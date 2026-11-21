import { expect, test } from '@playwright/test';
import { registerCustomer } from './support/data.js';
import {
  bookingAwaitingPayment,
  created,
  deliver,
  notice,
} from './support/payments.js';

test.describe('GET /bookings/:reference/documents', () => {
  test('lists the receipt of a paid booking for its owner only', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { customer, reference, totalMinor } = await bookingAwaitingPayment({
      request,
      playwright,
      baseURL,
    });
    const order = await created(customer, reference, totalMinor);
    const documents = async () =>
      (await customer.get(`bookings/${reference}/documents`)).json();

    // No receipt while the money has not arrived.
    expect(
      (await documents()).data.filter(
        (d: { kind: string }) => d.kind === 'RECEIPT',
      ),
    ).toEqual([]);

    const captured = notice('payment.captured', {
      orderId: order.checkout.orderId,
      amountMinor: totalMinor,
    });
    expect((await deliver(request, captured)).status()).toBe(200);

    const receipts = (await documents()).data.filter(
      (d: { kind: string }) => d.kind === 'RECEIPT',
    );
    expect(receipts).toEqual([
      expect.objectContaining({
        kind: 'RECEIPT',
        available: true,
        paymentReference: order.reference,
        issuedAt: expect.any(String),
      }),
    ]);

    // Another customer cannot list them, and learns nothing of the booking.
    const stranger = await playwright.request.newContext({ baseURL });
    await registerCustomer(stranger);
    const foreign = await stranger.get(`bookings/${reference}/documents`);
    expect(foreign.status()).toBe(404);
    expect(JSON.stringify(await foreign.json())).not.toContain(order.reference);
    await stranger.dispose();
  });
});

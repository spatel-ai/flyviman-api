import { describe, expect, it, vi } from 'vitest';
import {
  BookingMode,
  BookingPaymentStatus,
  BookingStatus,
  PaymentModel,
  PaymentStatus,
  PriceType,
  ServiceCategory,
} from '../../generated/prisma/enums.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { AuditService } from '../audit/audit.service.js';
import type { AvailabilityService } from '../availability/availability.service.js';
import { BookingsService } from './bookings.service.js';

const NOW = new Date('2026-11-20T12:00:00Z');
const HOUR = 3_600_000;

/** Only the hold is read here; every other dependency is left out. */
function withAvailability() {
  const availability = { recheckBookingHold: vi.fn().mockResolvedValue(true) };
  const none = {} as never;
  const service = new BookingsService(
    none,
    none,
    none,
    availability as unknown as AvailabilityService,
    none,
    none,
    none,
    none,
    none,
    none,
    none,
    none,
    none,
    none,
  );
  return { service, availability, tx: {} as Prisma.TransactionClient };
}

describe('BookingsService.evaluateConfirmation with a bad deposit percent', () => {
  it('asks for the full total instead of throwing, and audits a warning', async () => {
    const audit = { record: vi.fn() };
    const none = {} as never;
    const service = new BookingsService(
      none,
      audit as unknown as AuditService,
      none,
      none,
      none,
      none,
      none,
      none,
      none,
      none,
      none,
      none,
      none,
      none,
    );
    const tx = {
      $queryRaw: vi.fn(),
      booking: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'b-1',
          reference: 'FLY-AAAAAA',
          status: BookingStatus.AWAITING_PAYMENT,
          category: ServiceCategory.PRIVATE_CHARTER,
          bookingMode: BookingMode.REQUEST,
          priceType: PriceType.CONFIRMED,
          paymentModel: PaymentModel.C_DEPOSIT,
          paymentStatus: BookingPaymentStatus.PARTIALLY_PAID,
          operatorAcceptedAt: NOW,
          totalMinor: 1_000n,
          depositPercent: 0,
        }),
      },
      // The 25% deposit arrived.
      payment: {
        findMany: vi.fn().mockResolvedValue([
          {
            status: PaymentStatus.SUCCEEDED,
            reviewReason: null,
            amountMinor: 250n,
            refunds: [],
          },
        ]),
      },
    };

    await expect(
      service.evaluateConfirmation(
        tx as unknown as Prisma.TransactionClient,
        'b-1',
      ),
    ).resolves.toEqual({
      confirmed: false,
      reason: 'the money kept is less than the payment condition needs',
      unbookable: false,
    });
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record.mock.calls[0][0]).toMatchObject({
      action: 'booking.confirmation_warning',
      entityId: 'b-1',
      after: {
        depositPercent: 0,
        warning: expect.stringMatching(/full total/),
      },
    });
  });
});

describe('BookingsService.keepHoldForPayment', () => {
  it('keeps the hold of a booking being paid until the payment’s 48-hour bound', async () => {
    const { service, availability, tx } = withAvailability();
    const createdAt = new Date(NOW.getTime() - HOUR);
    await expect(
      service.keepHoldForPayment(
        tx,
        { id: 'b-1', status: BookingStatus.AWAITING_PAYMENT },
        createdAt,
        NOW,
      ),
    ).resolves.toBe(true);
    // The trip's end caps it inside `recheckBookingHold`.
    expect(availability.recheckBookingHold).toHaveBeenCalledWith(
      tx,
      'b-1',
      new Date(createdAt.getTime() + 48 * HOUR),
    );
  });

  it('keeps nothing once the bound has passed: the hold stops blocking', async () => {
    const { service, availability, tx } = withAvailability();
    await expect(
      service.keepHoldForPayment(
        tx,
        { id: 'b-1', status: BookingStatus.AWAITING_PAYMENT },
        new Date(NOW.getTime() - 48 * HOUR),
        NOW,
      ),
    ).resolves.toBe(false);
    expect(availability.recheckBookingHold).not.toHaveBeenCalled();
  });

  it('never takes up again the hold of a booking no longer awaiting payment', async () => {
    const { service, availability, tx } = withAvailability();
    for (const status of [
      BookingStatus.EXPIRED,
      BookingStatus.CANCELLED,
      BookingStatus.CONFIRMED,
    ]) {
      await expect(
        service.keepHoldForPayment(tx, { id: 'b-1', status }, NOW, NOW),
      ).resolves.toBe(false);
    }
    expect(availability.recheckBookingHold).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { BookingStatus } from '../../generated/prisma/enums.js';
import type { Prisma } from '../../generated/prisma/client.js';
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

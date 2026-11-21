import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { BookingRevalidationService } from './booking-revalidation.service.js';
import {
  type BookingsService,
  UNBOOKABLE,
  type UnbookableReason,
} from './bookings.service.js';

/** One open booking whose recheck answers `why`. */
function revalidating(why: UnbookableReason | null) {
  const tx = {
    booking: {
      findFirst: vi
        .fn()
        .mockResolvedValue({ id: 'b-1', status: 'AWAITING_PAYMENT' }),
    },
  };
  const prisma = {
    $transaction: vi.fn((work: (t: typeof tx) => unknown) => work(tx)),
  };
  const bookings = {
    unbookable: vi.fn().mockResolvedValue(why),
    getOwn: vi.fn().mockResolvedValue({ price: null, amountDue: null }),
  };
  const service = new BookingRevalidationService(
    prisma as unknown as PrismaService,
    bookings as unknown as BookingsService,
  );
  return service.revalidate({ id: 'u-1' } as AuthUser, 'FLY-AAAAAA');
}

describe('BookingRevalidationService reasons', () => {
  it("maps the recheck's reason constants to the customer's terms", async () => {
    expect(await revalidating(UNBOOKABLE.DEPARTED)).toMatchObject({
      available: false,
      reason: 'DEPARTED',
    });
    expect(await revalidating(UNBOOKABLE.TIME_TAKEN)).toMatchObject({
      available: false,
      reason: 'TIME_TAKEN',
    });
    expect(await revalidating(null)).toMatchObject({
      available: true,
      reason: null,
    });
  });

  it("keeps an operator's or aircraft's lost approval generic", async () => {
    for (const why of [
      UNBOOKABLE.OPERATOR_NOT_APPROVED,
      UNBOOKABLE.AIRCRAFT_NOT_IN_SERVICE,
    ]) {
      expect(await revalidating(why)).toMatchObject({
        available: false,
        reason: 'UNAVAILABLE',
      });
    }
  });
});

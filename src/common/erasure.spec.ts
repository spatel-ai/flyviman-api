import {
  AirAmbulanceStatus,
  BookingPaymentStatus,
  BookingStatus,
  PaymentStatus,
  RefundStatus,
  UserStatus,
} from '../generated/prisma/enums.js';
import {
  CLOSED_AIR_AMBULANCE_STATUSES,
  CLOSED_BOOKING_STATUSES,
  ERASED_TEXT,
  erasureBlockers,
  type ErasureFacts,
  SCRUBBED_AIR_AMBULANCE_CONTACT,
  SCRUBBED_BOOKING_PASSENGER,
  SCRUBBED_ENQUIRY,
  scrubbedUser,
} from './erasure.js';

const NOW = new Date('2026-11-21T12:00:00Z');
const LONG_AGO = new Date('2026-01-01T00:00:00Z');
const POLICY = { now: NOW, holdDays: 0 };

function facts(changes: Partial<ErasureFacts> = {}): ErasureFacts {
  return {
    bookings: [],
    payments: [],
    refunds: [],
    refundsDue: 0,
    airAmbulance: [],
    ...changes,
  };
}

function booking(
  status: BookingStatus,
  paymentStatus: BookingPaymentStatus = BookingPaymentStatus.UNPAID,
  updatedAt = LONG_AGO,
) {
  return { status, paymentStatus, updatedAt };
}

describe('closed statuses', () => {
  it('lets only finished bookings through, so a status added later blocks', () => {
    expect([...CLOSED_BOOKING_STATUSES].sort()).toEqual(
      [
        'CANCELLED',
        'COMPLETED',
        'EXPIRED',
        'OPERATOR_UNAVAILABLE',
        'QUOTE_DECLINED',
      ].sort(),
    );
  });

  it('lets only closed air ambulance requests through', () => {
    expect([...CLOSED_AIR_AMBULANCE_STATUSES].sort()).toEqual(
      ['CANCELLED', 'COMPLETED', 'DECLINED'].sort(),
    );
  });
});

describe('erasureBlockers', () => {
  it('allows an account with nothing at all', () => {
    expect(erasureBlockers(facts(), POLICY)).toEqual([]);
  });

  it('allows an account whose bookings and requests are all closed', () => {
    expect(
      erasureBlockers(
        facts({
          bookings: CLOSED_BOOKING_STATUSES.map((status) =>
            booking(status, BookingPaymentStatus.REFUNDED),
          ),
          payments: [
            { status: PaymentStatus.REFUNDED },
            { status: PaymentStatus.FAILED },
            { status: PaymentStatus.INITIATED },
          ],
          refunds: [
            { status: RefundStatus.COMPLETED },
            { status: RefundStatus.FAILED },
          ],
          airAmbulance: CLOSED_AIR_AMBULANCE_STATUSES.map((status) => ({
            status,
            updatedAt: LONG_AGO,
          })),
        }),
        POLICY,
      ),
    ).toEqual([]);
  });

  it.each(
    Object.values(BookingStatus).filter(
      (status) => !CLOSED_BOOKING_STATUSES.includes(status),
    ),
  )('blocks while a booking is %s', (status) => {
    expect(
      erasureBlockers(facts({ bookings: [booking(status)] }), POLICY),
    ).toEqual(['OPEN_BOOKINGS']);
  });

  it.each(
    Object.values(AirAmbulanceStatus).filter(
      (status) => !CLOSED_AIR_AMBULANCE_STATUSES.includes(status),
    ),
  )('blocks while an air ambulance request is %s', (status) => {
    expect(
      erasureBlockers(
        facts({ airAmbulance: [{ status, updatedAt: LONG_AGO }] }),
        POLICY,
      ),
    ).toEqual(['OPEN_AIR_AMBULANCE']);
  });

  it('blocks while a payment waits for the gateway', () => {
    expect(
      erasureBlockers(
        facts({ payments: [{ status: PaymentStatus.PENDING }] }),
        POLICY,
      ),
    ).toEqual(['PAYMENT_IN_PROGRESS']);
  });

  it.each([
    facts({ refunds: [{ status: RefundStatus.REQUESTED }] }),
    facts({ refunds: [{ status: RefundStatus.PENDING }] }),
    facts({ payments: [{ status: PaymentStatus.REFUND_PENDING }] }),
    facts({
      bookings: [
        booking(BookingStatus.CANCELLED, BookingPaymentStatus.REFUND_PENDING),
      ],
    }),
  ])('blocks while a refund is under way (%#)', (input) => {
    expect(erasureBlockers(input, POLICY)).toEqual(['REFUND_IN_PROGRESS']);
  });

  it('blocks while finance still owes the customer a refund', () => {
    expect(erasureBlockers(facts({ refundsDue: 1 }), POLICY)).toEqual([
      'REFUND_DUE',
    ]);
  });

  it('reports every reason, once each, in a fixed order', () => {
    expect(
      erasureBlockers(
        facts({
          bookings: [
            booking(BookingStatus.REQUESTED),
            booking(
              BookingStatus.CONFIRMED,
              BookingPaymentStatus.REFUND_PENDING,
            ),
          ],
          payments: [
            { status: PaymentStatus.PENDING },
            { status: PaymentStatus.PENDING },
          ],
          refundsDue: 2,
          airAmbulance: [
            { status: AirAmbulanceStatus.SUBMITTED, updatedAt: NOW },
          ],
        }),
        { now: NOW, holdDays: 30 },
      ),
    ).toEqual([
      'OPEN_BOOKINGS',
      'PAYMENT_IN_PROGRESS',
      'REFUND_IN_PROGRESS',
      'REFUND_DUE',
      'OPEN_AIR_AMBULANCE',
      'RECENT_ACTIVITY',
    ]);
  });

  describe('hold after the last activity (ERASURE_HOLD_DAYS)', () => {
    const yesterday = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
    const closedYesterday = facts({
      bookings: [
        booking(BookingStatus.COMPLETED, BookingPaymentStatus.PAID, yesterday),
      ],
    });

    it('does not apply at 0 days, the default', () => {
      expect(erasureBlockers(closedYesterday, POLICY)).toEqual([]);
    });

    it('refuses within the hold and allows after it', () => {
      expect(
        erasureBlockers(closedYesterday, { now: NOW, holdDays: 2 }),
      ).toEqual(['RECENT_ACTIVITY']);
      expect(
        erasureBlockers(closedYesterday, { now: NOW, holdDays: 1 }),
      ).toEqual([]);
    });

    it('counts air ambulance requests too', () => {
      expect(
        erasureBlockers(
          facts({
            airAmbulance: [
              { status: AirAmbulanceStatus.CANCELLED, updatedAt: yesterday },
            ],
          }),
          { now: NOW, holdDays: 7 },
        ),
      ).toEqual(['RECENT_ACTIVITY']);
    });
  });
});

describe('scrubbed values', () => {
  it('leaves the account no identifier, password or verification', () => {
    const user = scrubbedUser(NOW);
    expect(user).toMatchObject({
      email: null,
      phone: null,
      passwordHash: null,
      status: UserStatus.ERASED,
      erasedAt: NOW,
      emailVerifiedAt: null,
      phoneVerifiedAt: null,
    });
  });

  it('clears every personal field of a passenger snapshot', () => {
    expect(SCRUBBED_BOOKING_PASSENGER).toEqual({
      passengerId: null,
      firstName: ERASED_TEXT,
      lastName: '',
      dateOfBirth: null,
      gender: 'UNSPECIFIED',
      nationality: null,
      documentType: null,
      documentNumber: null,
      documentExpiry: null,
      specialAssistance: null,
    });
  });

  it('clears every contact and address of an air ambulance request', () => {
    expect(SCRUBBED_AIR_AMBULANCE_CONTACT).toEqual({
      contactName: ERASED_TEXT,
      contactPhone: '',
      contactEmail: null,
      emergencyContactName: null,
      emergencyContactPhone: null,
      pickupAddress: null,
      destinationFacility: null,
    });
  });

  it('clears the sender and message of an enquiry', () => {
    expect(SCRUBBED_ENQUIRY).toEqual({
      name: ERASED_TEXT,
      email: null,
      phone: null,
      message: ERASED_TEXT,
    });
  });
});

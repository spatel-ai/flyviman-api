import {
  AirAmbulanceStatus,
  BookingPaymentStatus,
  BookingStatus,
  PaymentReviewReason,
  PaymentStatus,
  RefundStatus,
  UserStatus,
} from '../generated/prisma/enums.js';
import { Prisma } from '../generated/prisma/browser.js';
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

function payment(
  status: PaymentStatus,
  reviewReason: PaymentReviewReason | null = null,
  reviewResolvedAt: Date | null = null,
) {
  return { status, reviewReason, reviewResolvedAt };
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
            payment(PaymentStatus.REFUNDED),
            payment(PaymentStatus.FAILED),
            payment(PaymentStatus.INITIATED),
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
        facts({ payments: [payment(PaymentStatus.PENDING)] }),
        POLICY,
      ),
    ).toEqual(['PAYMENT_IN_PROGRESS']);
  });

  it.each([
    facts({ refunds: [{ status: RefundStatus.REQUESTED }] }),
    facts({ refunds: [{ status: RefundStatus.PENDING }] }),
    facts({ payments: [payment(PaymentStatus.REFUND_PENDING)] }),
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

  it.each([
    PaymentReviewReason.AMOUNT_MISMATCH,
    PaymentReviewReason.DUPLICATE_CAPTURE,
  ])(
    'blocks while a payment flagged %s holds money the refund queue leaves out',
    (reason) => {
      expect(
        erasureBlockers(
          facts({ payments: [payment(PaymentStatus.SUCCEEDED, reason)] }),
          POLICY,
        ),
      ).toEqual(['PAYMENT_UNDER_REVIEW']);
    },
  );

  it.each([
    PaymentReviewReason.AMOUNT_MISMATCH,
    PaymentReviewReason.DUPLICATE_CAPTURE,
  ])('no longer blocks once finance resolved the %s flag', (reason) => {
    expect(
      erasureBlockers(
        facts({
          payments: [payment(PaymentStatus.SUCCEEDED, reason, LONG_AGO)],
        }),
        POLICY,
      ),
    ).toEqual([]);
  });

  it.each([
    PaymentReviewReason.BOOKING_CLOSED,
    PaymentReviewReason.ALREADY_PAID,
  ])(
    'leaves a payment flagged %s to the refund queue (REFUND_DUE)',
    (reason) => {
      expect(
        erasureBlockers(
          facts({ payments: [payment(PaymentStatus.SUCCEEDED, reason)] }),
          POLICY,
        ),
      ).toEqual([]);
    },
  );

  it.each([BookingPaymentStatus.UNPAID, BookingPaymentStatus.PARTIALLY_PAID])(
    'blocks while a flown trip is %s',
    (paymentStatus) => {
      expect(
        erasureBlockers(
          facts({
            bookings: [booking(BookingStatus.COMPLETED, paymentStatus)],
          }),
          POLICY,
        ),
      ).toEqual(['BALANCE_DUE']);
    },
  );

  it('does not count an unpaid booking that never flew as owed', () => {
    expect(
      erasureBlockers(
        facts({
          bookings: [
            booking(BookingStatus.CANCELLED, BookingPaymentStatus.UNPAID),
            booking(BookingStatus.EXPIRED, BookingPaymentStatus.PARTIALLY_PAID),
            booking(BookingStatus.COMPLETED, BookingPaymentStatus.PAID),
          ],
        }),
        POLICY,
      ),
    ).toEqual([]);
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
            booking(
              BookingStatus.COMPLETED,
              BookingPaymentStatus.PARTIALLY_PAID,
            ),
          ],
          payments: [
            payment(PaymentStatus.PENDING),
            payment(
              PaymentStatus.SUCCEEDED,
              PaymentReviewReason.DUPLICATE_CAPTURE,
            ),
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
      'PAYMENT_UNDER_REVIEW',
      'BALANCE_DUE',
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

/**
 * Every column of a scrubbed table is either written by the erasure or
 * listed here as kept on purpose, so a personal column added later fails
 * this spec until it is decided.
 */
function columnsLeftOut(
  fields: Record<string, string>,
  scrubbed: object,
  kept: string[],
): string[] {
  return Object.values(fields).filter(
    (field) => !Object.hasOwn(scrubbed, field) && !kept.includes(field),
  );
}

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
      smsOptedOut: false,
      whatsappOptedOut: false,
    });
    expect(
      columnsLeftOut(Prisma.UserScalarFieldEnum, user, [
        'id',
        'role',
        'createdAt',
        'updatedAt',
      ]),
    ).toEqual([]);
  });

  it('clears every personal column of a passenger snapshot', () => {
    expect(SCRUBBED_BOOKING_PASSENGER).toMatchObject({
      firstName: ERASED_TEXT,
      lastName: '',
      documentNumber: null,
      specialAssistance: null,
    });
    expect(
      columnsLeftOut(
        Prisma.BookingPassengerScalarFieldEnum,
        SCRUBBED_BOOKING_PASSENGER,
        ['id', 'bookingId', 'createdAt', 'updatedAt'],
      ),
    ).toEqual([]);
    expect(
      Object.values(SCRUBBED_BOOKING_PASSENGER).filter(
        (value) => value !== null && value !== '' && value !== ERASED_TEXT,
      ),
    ).toEqual(['UNSPECIFIED']);
  });

  it('clears every contact and address of an air ambulance request, keeping the operational record', () => {
    expect(
      Object.values(SCRUBBED_AIR_AMBULANCE_CONTACT).every(
        (value) => value === null || value === '' || value === ERASED_TEXT,
      ),
    ).toBe(true);
    expect(
      columnsLeftOut(
        Prisma.AirAmbulanceRequestScalarFieldEnum,
        SCRUBBED_AIR_AMBULANCE_CONTACT,
        [
          'id',
          'reference',
          'requesterId',
          'originLocationId',
          'destinationLocationId',
          'preferredAt',
          'patientCount',
          'accompanyingPersons',
          'status',
          'assignedToId',
          'selectedOperatorId',
          'quoteAmountMinor',
          'quoteCurrency',
          'quoteConditions',
          'quotedAt',
          'feasibility',
          'confirmedAt',
          'completedAt',
          'closedAt',
          'createdAt',
          'updatedAt',
        ],
      ),
    ).toEqual([]);
  });

  it('clears the sender and message of an enquiry', () => {
    expect(SCRUBBED_ENQUIRY).toEqual({
      name: ERASED_TEXT,
      email: null,
      phone: null,
      message: ERASED_TEXT,
    });
    expect(
      columnsLeftOut(Prisma.EnquiryScalarFieldEnum, SCRUBBED_ENQUIRY, [
        'id',
        'reference',
        'topic',
        'handledAt',
        'createdAt',
        'updatedAt',
      ]),
    ).toEqual([]);
  });
});

import {
  AirAmbulanceStatus,
  BookingPaymentStatus,
  BookingStatus,
  Gender,
  PaymentStatus,
  RefundStatus,
  UserStatus,
} from '../generated/prisma/enums.js';

/**
 * Erasure of a customer's personal data (DPDP Act, W5-8b): who may be erased
 * and what each scrubbed record holds afterwards. Pure, so the decision and
 * the values are tested without a database; each owning module writes its
 * own table with these values (`modules/privacy/erasure.service.ts`).
 */

/** Stands in for a required text field whose value was erased. */
export const ERASED_TEXT = '[erased]';

/**
 * Booking statuses after which nothing more happens to a booking. Any other
 * status, including one added later, keeps the account from being erased.
 */
export const CLOSED_BOOKING_STATUSES: readonly BookingStatus[] = [
  BookingStatus.COMPLETED,
  BookingStatus.OPERATOR_UNAVAILABLE,
  BookingStatus.QUOTE_DECLINED,
  BookingStatus.EXPIRED,
  BookingStatus.CANCELLED,
];

/** Closed air ambulance requests (state-machines.md); the rest are live. */
export const CLOSED_AIR_AMBULANCE_STATUSES: readonly AirAmbulanceStatus[] = [
  AirAmbulanceStatus.COMPLETED,
  AirAmbulanceStatus.DECLINED,
  AirAmbulanceStatus.CANCELLED,
];

/** Why an account cannot be erased yet, in the order they are reported. */
export const ERASURE_BLOCKERS = [
  'OPEN_BOOKINGS',
  'PAYMENT_IN_PROGRESS',
  'REFUND_IN_PROGRESS',
  'REFUND_DUE',
  'OPEN_AIR_AMBULANCE',
  'RECENT_ACTIVITY',
] as const;
export type ErasureBlocker = (typeof ERASURE_BLOCKERS)[number];

/** What the decision is made on, read under the erasure's locks. */
export interface ErasureFacts {
  bookings: readonly {
    status: BookingStatus;
    paymentStatus: BookingPaymentStatus;
    updatedAt: Date;
  }[];
  /** Every payment on the customer's bookings. */
  payments: readonly { status: PaymentStatus }[];
  /** Every refund of those payments. */
  refunds: readonly { status: RefundStatus }[];
  /** Payments the finance refund queue says are owed back to the customer. */
  refundsDue: number;
  airAmbulance: readonly { status: AirAmbulanceStatus; updatedAt: Date }[];
}

export interface ErasurePolicy {
  now: Date;
  /**
   * `ERASURE_HOLD_DAYS`: days after the last change to any of the
   * customer's bookings or air ambulance requests during which erasure is
   * refused, so a dispute or chargeback can still be answered. 0 erases at
   * once (the default while data retention is an open decision).
   */
  holdDays: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The reasons an account cannot be erased now; empty when it can. A payment
 * in progress is one waiting for the gateway (`PENDING`), as
 * `bookings/payment-in-progress.ts` defines it.
 */
export function erasureBlockers(
  facts: ErasureFacts,
  policy: ErasurePolicy,
): ErasureBlocker[] {
  const found = new Set<ErasureBlocker>();
  if (
    facts.bookings.some(
      (booking) => !CLOSED_BOOKING_STATUSES.includes(booking.status),
    )
  ) {
    found.add('OPEN_BOOKINGS');
  }
  if (facts.payments.some((p) => p.status === PaymentStatus.PENDING)) {
    found.add('PAYMENT_IN_PROGRESS');
  }
  if (
    facts.refunds.some(
      (refund) =>
        refund.status === RefundStatus.REQUESTED ||
        refund.status === RefundStatus.PENDING,
    ) ||
    facts.payments.some((p) => p.status === PaymentStatus.REFUND_PENDING) ||
    facts.bookings.some(
      (booking) =>
        booking.paymentStatus === BookingPaymentStatus.REFUND_PENDING,
    )
  ) {
    found.add('REFUND_IN_PROGRESS');
  }
  if (facts.refundsDue > 0) found.add('REFUND_DUE');
  if (
    facts.airAmbulance.some(
      (request) => !CLOSED_AIR_AMBULANCE_STATUSES.includes(request.status),
    )
  ) {
    found.add('OPEN_AIR_AMBULANCE');
  }
  if (policy.holdDays > 0) {
    const since = policy.now.getTime() - policy.holdDays * DAY_MS;
    const recent = [...facts.bookings, ...facts.airAmbulance].some(
      (record) => record.updatedAt.getTime() > since,
    );
    if (recent) found.add('RECENT_ACTIVITY');
  }
  return ERASURE_BLOCKERS.filter((blocker) => found.has(blocker));
}

/**
 * The account row once erased: no identifier, password or verification is
 * left (CHECK `User_erased_scrubbed`), so it cannot sign in, receive a code
 * or be found by address, and the address can be registered again.
 */
export function scrubbedUser(now: Date) {
  return {
    email: null,
    phone: null,
    passwordHash: null,
    status: UserStatus.ERASED,
    erasedAt: now,
    suspendedBy: null,
    emailVerifiedAt: null,
    phoneVerifiedAt: null,
    lastLoginAt: null,
  };
}

/**
 * A booking's passenger snapshot once erased. The row stays, so the number of
 * passengers flown is kept for the booking's record.
 */
export const SCRUBBED_BOOKING_PASSENGER = {
  passengerId: null,
  firstName: ERASED_TEXT,
  lastName: '',
  dateOfBirth: null,
  gender: Gender.UNSPECIFIED,
  nationality: null,
  documentType: null,
  documentNumber: null,
  documentExpiry: null,
  specialAssistance: null,
};

/**
 * A closed air ambulance request once erased: the patient's and contacts'
 * identifiers go; the operational record (route, times, status, quotation,
 * feasibility checklist) stays. Its medical details and documents are
 * deleted separately.
 */
export const SCRUBBED_AIR_AMBULANCE_CONTACT = {
  contactName: ERASED_TEXT,
  contactPhone: '',
  contactEmail: null,
  emergencyContactName: null,
  emergencyContactPhone: null,
  pickupAddress: null,
  destinationFacility: null,
};

/** A contact-page enquiry sent from the erased customer's address. */
export const SCRUBBED_ENQUIRY = {
  name: ERASED_TEXT,
  email: null,
  phone: null,
  message: ERASED_TEXT,
};

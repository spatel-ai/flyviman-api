import { describe, expect, it } from 'vitest';
import {
  bookingStatusEvents,
  channelsFor,
  hrefFor,
  NOTIFICATION_MATRIX,
  optedOutChannels,
  refundStatusEvent,
  ruleFor,
} from './matrix.js';

describe('NOTIFICATION_MATRIX', () => {
  it('has one rule per event', () => {
    const keys = NOTIFICATION_MATRIX.map((rule) => rule.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('always keeps the record: in-app and email', () => {
    for (const rule of NOTIFICATION_MATRIX) {
      expect(rule.channels, rule.key).toContain('IN_APP');
      expect(rule.channels, rule.key).toContain('EMAIL');
    }
  });

  it('covers the events of the brief', () => {
    const keys = NOTIFICATION_MATRIX.map((rule) => rule.key);
    for (const key of [
      'booking.requested',
      'booking.price_confirmed',
      'booking.operator_unavailable',
      'booking.clarification_requested',
      'booking.quote_sent',
      'booking.clarification_answered',
      'booking.quote_accepted',
      'booking.quote_declined',
      'booking.cancelled_by_customer',
      'booking.change_requested',
      'booking.change_decided',
      'payment.succeeded',
      'payment.failed',
      'booking.confirmed',
      'booking.confirmed_operator',
      'booking.expired',
      'air_ambulance.received',
      'air_ambulance.quoted',
      'air_ambulance.confirmed',
      'air_ambulance.cancelled',
    ]) {
      expect(keys, key).toContain(key);
    }
  });

  it('sends a new air ambulance request to operations and the rest to the customer', () => {
    expect(ruleFor('air_ambulance.received').audience).toBe('OPERATIONS');
    for (const key of ['quoted', 'confirmed', 'cancelled']) {
      expect(ruleFor(`air_ambulance.${key}`).audience).toBe('CUSTOMER');
    }
  });

  it('tells the customer of a refund started and completed, operations of a failure, and only the operator administrators of a settlement change', () => {
    for (const key of ['refund.initiated', 'refund.completed']) {
      expect(ruleFor(key), key).toMatchObject({
        audience: 'CUSTOMER',
        channels: ['IN_APP', 'EMAIL'],
        mandatory: true,
      });
    }
    expect(ruleFor('refund.failed')).toMatchObject({
      audience: 'OPERATIONS',
      channels: ['IN_APP', 'EMAIL'],
    });
    expect(ruleFor('settlement.updated')).toMatchObject({
      audience: 'OPERATOR',
      subject: 'SETTLEMENT',
      channels: ['IN_APP', 'EMAIL'],
    });
  });

  it('refuses an unknown event', () => {
    expect(() => ruleFor('nope')).toThrow(/No notification rule/);
  });
});

describe('channelsFor', () => {
  const urgent = ruleFor('booking.quote_sent');
  const mandatory = ruleFor('payment.failed');

  it('includes WhatsApp only when it is enabled', () => {
    expect(channelsFor(urgent, { whatsappEnabled: true })).toEqual([
      'IN_APP',
      'EMAIL',
      'SMS',
      'WHATSAPP',
    ]);
    expect(channelsFor(urgent, { whatsappEnabled: false })).toEqual([
      'IN_APP',
      'EMAIL',
      'SMS',
    ]);
  });

  it('respects an opt-out, but never of in-app or of a mandatory message', () => {
    const optedOut = ['IN_APP', 'EMAIL', 'SMS'] as const;
    expect(channelsFor(urgent, { whatsappEnabled: true, optedOut })).toEqual([
      'IN_APP',
      'WHATSAPP',
    ]);
    expect(channelsFor(mandatory, { whatsappEnabled: true, optedOut })).toEqual(
      ['IN_APP', 'EMAIL', 'SMS', 'WHATSAPP'],
    );
  });
});

describe('hrefFor', () => {
  it('points each reader to their own portal', () => {
    expect(hrefFor(ruleFor('booking.quote_sent'), 'FV-1')).toBe(
      '/account/trips/FV-1',
    );
    expect(hrefFor(ruleFor('booking.requested'), 'FV-1')).toBe(
      '/operator/requests/FV-1',
    );
    expect(hrefFor(ruleFor('air_ambulance.quoted'), 'AA-1')).toBe(
      '/air-ambulance/requests/AA-1',
    );
    expect(hrefFor(ruleFor('air_ambulance.received'), 'AA-1')).toBe(
      '/admin/air-ambulance/AA-1',
    );
    expect(hrefFor(ruleFor('refund.completed'), 'FV-1')).toBe(
      '/account/trips/FV-1',
    );
    expect(hrefFor(ruleFor('refund.failed'), 'FV-1')).toBe(
      '/admin/bookings/FV-1',
    );
    expect(hrefFor(ruleFor('settlement.updated'), 'FV-1')).toBe(
      '/operator/settlements',
    );
  });
});

describe('refundStatusEvent', () => {
  it('tells the customer of a completed refund and operations of a failed one, nothing for a pending one', () => {
    expect(refundStatusEvent('COMPLETED')).toBe('refund.completed');
    expect(refundStatusEvent('FAILED')).toBe('refund.failed');
    expect(refundStatusEvent('PENDING')).toBeNull();
    expect(refundStatusEvent('REQUESTED')).toBeNull();
  });
});

describe('bookingStatusEvents', () => {
  it('tells the operator when the customer declines a confirmed price, and the customer of an operations override', () => {
    expect(
      bookingStatusEvents('PRICE_CONFIRMED', 'QUOTE_DECLINED', 'CUSTOMER'),
    ).toEqual(['booking.price_declined']);
    expect(
      bookingStatusEvents('OPERATOR_PENDING', 'EXPIRED', 'OPERATIONS'),
    ).toEqual(['booking.expired']);
    expect(
      bookingStatusEvents(
        'OPERATOR_PENDING',
        'OPERATOR_UNAVAILABLE',
        'OPERATIONS',
      ),
    ).toEqual(['booking.operator_unavailable']);
    // The expiry job and the operator's answer notify where they happen.
    expect(
      bookingStatusEvents('OPERATOR_PENDING', 'EXPIRED', 'SYSTEM'),
    ).toEqual([]);
    expect(
      bookingStatusEvents('PRICE_CONFIRMED', 'AWAITING_PAYMENT', 'SYSTEM'),
    ).toEqual([]);
    expect(ruleFor('booking.price_overridden')).toMatchObject({
      audience: 'CUSTOMER',
    });
  });

  it('tells the operator of a new request, not of the other early moves', () => {
    expect(
      bookingStatusEvents('REQUESTED', 'OPERATOR_PENDING', 'SYSTEM'),
    ).toEqual(['booking.requested']);
    expect(
      bookingStatusEvents(
        'CLARIFICATION_REQUESTED',
        'OPERATOR_PENDING',
        'CUSTOMER',
      ),
    ).toEqual([]);
    expect(
      bookingStatusEvents('OPERATOR_PENDING', 'PRICE_CONFIRMED', 'OPERATOR'),
    ).toEqual([]);
  });

  it('tells both sides of a confirmation', () => {
    expect(
      bookingStatusEvents('AWAITING_PAYMENT', 'CONFIRMED', 'SYSTEM'),
    ).toEqual(['booking.confirmed', 'booking.confirmed_operator']);
  });

  it('tells the operator of a cancellation only when the customer cancelled', () => {
    expect(bookingStatusEvents('CONFIRMED', 'CANCELLED', 'CUSTOMER')).toEqual([
      'booking.cancelled',
      'booking.cancelled_by_customer',
    ]);
    expect(bookingStatusEvents('CONFIRMED', 'CANCELLED', 'OPERATIONS')).toEqual(
      ['booking.cancelled'],
    );
  });
});

describe('optedOutChannels', () => {
  it('maps the stored opt-outs to SMS and WhatsApp only', () => {
    expect(
      optedOutChannels({ smsOptedOut: false, whatsappOptedOut: false }),
    ).toEqual([]);
    expect(
      optedOutChannels({ smsOptedOut: true, whatsappOptedOut: false }),
    ).toEqual(['SMS']);
    expect(
      optedOutChannels({ smsOptedOut: true, whatsappOptedOut: true }),
    ).toEqual(['SMS', 'WHATSAPP']);
  });
});

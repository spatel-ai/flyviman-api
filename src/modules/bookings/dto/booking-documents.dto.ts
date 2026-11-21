import { ApiProperty } from '@nestjs/swagger';

export const BOOKING_DOCUMENT_KINDS = [
  'CONFIRMATION',
  'RECEIPT',
  'CANCELLATION_TERMS',
] as const;

export type BookingDocumentKind = (typeof BOOKING_DOCUMENT_KINDS)[number];

/**
 * One document of a booking, worked out from the booking and its payments
 * (nothing is stored). The client opens it from its kind: the booking's
 * itinerary page, the payment's receipt, or the terms on the booking.
 */
export class BookingDocumentDto {
  @ApiProperty({
    enum: BOOKING_DOCUMENT_KINDS,
    enumName: 'BookingDocumentKind',
    description:
      '`CONFIRMATION`: the confirmed itinerary, from the booking (`GET /bookings/:reference`). `RECEIPT`: a payment whose money arrived (`GET /payments/:paymentReference/receipt`). `CANCELLATION_TERMS`: the terms the customer accepted when requesting (`cancellationTerms` on the booking).',
  })
  kind: BookingDocumentKind;

  @ApiProperty({ example: 'Booking confirmation' })
  title: string;

  @ApiProperty({
    description:
      'Whether it can be opened now. The confirmation is listed before the booking is confirmed, unavailable, so the customer knows it is coming.',
  })
  available: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'FLY-PY-7K2M9Q',
    description: 'For a `RECEIPT`, the payment; null otherwise.',
  })
  paymentReference: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'When it was issued: confirmed, paid, or the terms accepted. Null while unavailable.',
  })
  issuedAt: string | null;
}

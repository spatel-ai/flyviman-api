import { HttpStatus } from '@nestjs/common';
import { AppException } from './errors/app.exception.js';
import { indiaToday } from './india-date.js';

/**
 * The dates on an uploaded compliance document (operator or aircraft): it
 * must not already be expired, counted on today's date in India like every
 * other expiry rule (D-072), and cannot expire before it was issued.
 */
export function assertDocumentDates(
  issuedAt?: string | null,
  expiresAt?: string | null,
): void {
  if (expiresAt && expiresAt.slice(0, 10) < indiaToday()) {
    throw new AppException(
      'VALIDATION_ERROR',
      'The expiry date cannot be in the past.',
      HttpStatus.BAD_REQUEST,
      [{ field: 'expiresAt', issue: 'must not be in the past' }],
    );
  }
  if (issuedAt && expiresAt && issuedAt > expiresAt) {
    throw new AppException(
      'VALIDATION_ERROR',
      'The issue date cannot be after the expiry date.',
      HttpStatus.BAD_REQUEST,
      [{ field: 'issuedAt', issue: 'must not be after the expiry date' }],
    );
  }
}

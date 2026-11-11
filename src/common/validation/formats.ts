import { applyDecorators } from '@nestjs/common';
import { IsDateString, Matches } from 'class-validator';

/** E.164 phone number, for example +919876543210. */
export const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * A calendar date, `YYYY-MM-DD`, and nothing more. A full timestamp is
 * refused: converted to a date it could land on the neighbouring day.
 */
export const IsDateOnly = () =>
  applyDecorators(
    Matches(/^\d{4}-\d{2}-\d{2}$/, {
      message: '$property must be a date in the form YYYY-MM-DD',
    }),
    IsDateString({ strict: true }),
  );

/** A date-only column as `YYYY-MM-DD`, or `null`. */
export function day(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

import { HttpStatus, Injectable, type PipeTransform } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception.js';
import { BOOKING_REFERENCE } from '../../common/reference.js';

/** A path's booking reference; anything else is a booking that is not found. */
@Injectable()
export class BookingReferencePipe implements PipeTransform<string, string> {
  transform(value: string): string {
    const reference = value.toUpperCase();
    if (!BOOKING_REFERENCE.test(reference)) {
      throw new AppException(
        'NOT_FOUND',
        'Booking not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    return reference;
  }
}

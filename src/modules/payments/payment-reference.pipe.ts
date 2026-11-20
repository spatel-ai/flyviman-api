import { HttpStatus, Injectable, type PipeTransform } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception.js';
import { PAYMENT_REFERENCE } from '../../common/reference.js';

/** A path's payment reference; anything else is a payment that is not found. */
@Injectable()
export class PaymentReferencePipe implements PipeTransform<string, string> {
  transform(value: string): string {
    const reference = value.toUpperCase();
    if (!PAYMENT_REFERENCE.test(reference)) {
      throw new AppException(
        'NOT_FOUND',
        'Payment not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    return reference;
  }
}

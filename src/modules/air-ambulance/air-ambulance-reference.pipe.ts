import { HttpStatus, Injectable, type PipeTransform } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception.js';
import { AIR_AMBULANCE_REFERENCE } from '../../common/reference.js';

/** A path's request reference; anything else is a request not found. */
@Injectable()
export class AirAmbulanceReferencePipe implements PipeTransform<
  string,
  string
> {
  transform(value: string): string {
    const reference = value.toUpperCase();
    if (!AIR_AMBULANCE_REFERENCE.test(reference)) {
      throw new AppException(
        'NOT_FOUND',
        'Air ambulance request not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    return reference;
  }
}

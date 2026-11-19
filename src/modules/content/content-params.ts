import { HttpStatus, Injectable, PipeTransform } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception.js';

function refuse(field: string, issue: string): AppException {
  return new AppException(
    'VALIDATION_ERROR',
    'The request is not valid.',
    HttpStatus.BAD_REQUEST,
    [{ field, issue }],
  );
}

@Injectable()
export class PolicySlugPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(value) || value.length > 60) {
      throw refuse('slug', 'Use lower-case letters, digits and hyphens.');
    }
    return value;
  }
}

@Injectable()
export class TemplateKeyPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!/^[a-z0-9_.]{1,80}$/.test(value)) {
      throw refuse('key', 'Not a template key.');
    }
    return value;
  }
}

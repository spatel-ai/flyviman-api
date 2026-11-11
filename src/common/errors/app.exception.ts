import { HttpException, HttpStatus } from '@nestjs/common';

export interface ErrorDetail {
  field?: string;
  issue: string;
}

/**
 * Business error with a stable code from the catalogue in
 * docs/api/api-design.md. Clients switch on `code`, never on `message`.
 */
export class AppException extends HttpException {
  constructor(
    readonly code: string,
    message: string,
    status: HttpStatus,
    readonly details: ErrorDetail[] = [],
  ) {
    super(message, status);
  }
}

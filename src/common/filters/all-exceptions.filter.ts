import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppException, ErrorDetail } from '../errors/app.exception.js';

const STATUS_CODES: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'VALIDATION_ERROR',
  [HttpStatus.UNAUTHORIZED]: 'UNAUTHENTICATED',
  [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
  [HttpStatus.CONFLICT]: 'CONFLICT',
  [HttpStatus.GONE]: 'GONE',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'UNPROCESSABLE',
  [HttpStatus.TOO_MANY_REQUESTS]: 'RATE_LIMITED',
};

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    details: ErrorDetail[];
    requestId: string | null;
  };
}

/** Enough to find the fault, with nothing a user typed: class, code, frames. */
export function describeError(exception: unknown): string {
  if (!(exception instanceof Error)) return 'non-error thrown';
  const code = (exception as { code?: unknown }).code;
  const frames = (exception.stack ?? '')
    .split('\n')
    .filter((line) => line.trimStart().startsWith('at '))
    .slice(0, 5)
    .map((line) => line.trim())
    .join(' ');
  return [
    exception.constructor.name,
    typeof code === 'string' ? `code=${code}` : '',
    frames,
  ]
    .filter(Boolean)
    .join(' ');
}

/** Converts every thrown error into the error envelope from api-design.md. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request & { id?: string }>();
    const response = http.getResponse<Response>();
    const requestId = request.id ?? null;

    const { status, code, message, details } = this.describe(exception);

    if (status >= 500) {
      // Request bodies and headers are never logged. Nor is the message of
      // an unexpected error: a database error's message repeats the values
      // of the query that failed, which can be personal data.
      this.logger.error(
        `${request.method} ${request.path} failed (requestId=${requestId}): ${describeError(exception)}`,
      );
    }

    const body: ErrorBody = { error: { code, message, details, requestId } };
    response.status(status).json(body);
  }

  private describe(exception: unknown): {
    status: number;
    code: string;
    message: string;
    details: ErrorDetail[];
  } {
    if (exception instanceof AppException) {
      return {
        status: exception.getStatus(),
        code: exception.code,
        message: exception.message,
        details: exception.details,
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      const details =
        typeof payload === 'object' && payload !== null && 'details' in payload
          ? (payload as { details: ErrorDetail[] }).details
          : [];
      return {
        status,
        code: STATUS_CODES[status] ?? 'HTTP_ERROR',
        message: exception.message,
        details,
      };
    }

    // Unknown errors never leak internals to the client.
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong. Please try again.',
      details: [],
    };
  }
}

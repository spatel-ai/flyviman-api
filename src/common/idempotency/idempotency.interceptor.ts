import { createHash } from 'node:crypto';
import {
  CallHandler,
  ExecutionContext,
  HttpStatus,
  Injectable,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { catchError, from, mergeMap, Observable, of, switchMap } from 'rxjs';
import { AppException } from '../errors/app.exception.js';
import { IdempotencyStore } from './idempotency.store.js';

const IDEMPOTENT = 'idempotent';
const HEADER = 'idempotency-key';
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** How long a finished response is replayed for (api-design.md). */
export const IDEMPOTENCY_WINDOW_SECONDS = 24 * 60 * 60;
/** How long an unfinished request holds its key before a retry may start. */
const PENDING_SECONDS = 60;

/**
 * Marks a route as requiring an `Idempotency-Key` header. A repeat with the
 * same key and body gets the first response again instead of running twice.
 */
export const Idempotent = () => SetMetadata(IDEMPOTENT, true);

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly store: IdempotencyStore,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const required = this.reflector.getAllAndOverride<boolean | undefined>(
      IDEMPOTENT,
      [context.getHandler(), context.getClass()],
    );
    if (!required) return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const key = request.header(HEADER);
    if (!key || !UUID.test(key)) {
      throw new AppException(
        'VALIDATION_ERROR',
        'This request needs an Idempotency-Key header holding a UUID.',
        HttpStatus.BAD_REQUEST,
        [{ field: 'Idempotency-Key', issue: 'must be a UUID' }],
      );
    }

    // Scoped to the signed-in user and the route. Public routes have no
    // user, so every caller shares the "anonymous" scope there: a replay
    // still needs the same random key and the same body, and returns only
    // what that request returned (for enquiries, a reference and a time).
    const owner = request.user?.id ?? 'anonymous';
    const route = `${request.method}:${request.baseUrl}${request.path}`;
    const storeKey = `idem:${owner}:${route}:${key}`;
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(request.body ?? null))
      .digest('hex');

    return from(this.store.begin(storeKey, fingerprint, PENDING_SECONDS)).pipe(
      switchMap((existing) => {
        if (existing === null) {
          return next.handle().pipe(
            mergeMap(async (body: unknown) => {
              await this.store.complete(
                storeKey,
                {
                  fingerprint,
                  state: 'completed',
                  status: response.statusCode,
                  body,
                },
                IDEMPOTENCY_WINDOW_SECONDS,
              );
              return body;
            }),
            catchError(async (error: unknown) => {
              await this.store.release(storeKey);
              throw error;
            }),
          );
        }

        if (existing.fingerprint !== fingerprint) {
          throw new AppException(
            'IDEMPOTENCY_CONFLICT',
            'This Idempotency-Key was already used with a different request.',
            HttpStatus.CONFLICT,
          );
        }
        if (existing.state === 'pending') {
          response.setHeader('Retry-After', '2');
          throw new AppException(
            'IDEMPOTENCY_CONFLICT',
            'The first request with this Idempotency-Key is still being processed. Retry shortly.',
            HttpStatus.CONFLICT,
          );
        }

        response.status(existing.status ?? HttpStatus.OK);
        response.setHeader('Idempotent-Replayed', 'true');
        return of(existing.body);
      }),
    );
  }
}

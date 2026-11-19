import { createHmac, hkdfSync, randomUUID } from 'node:crypto';
import {
  CallHandler,
  createParamDecorator,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { catchError, from, mergeMap, Observable, of, switchMap } from 'rxjs';
import { IdempotencyKeyStatus } from '../../generated/prisma/enums.js';
import { IS_PUBLIC } from '../../modules/auth/auth.decorators.js';
import { AppException } from '../errors/app.exception.js';
import {
  IdempotencyClaim,
  IdempotencyLease,
  IdempotencyStore,
} from './idempotency.store.js';

const IDEMPOTENT = 'idempotent';
const HEADER = 'idempotency-key';
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** How long a finished response is replayed for (api-design.md). */
export const IDEMPOTENCY_WINDOW_SECONDS = 24 * 60 * 60;
/** Claims tried before answering "still in progress" (each loss is a race). */
const CLAIM_ATTEMPTS = 3;

/** Label that derives the request-hash key from DATA_ENCRYPTION_KEY. */
const HASH_KEY_INFO = 'flyviman:idempotency-request-hash:v1';

/**
 * The scope a key is claimed in: the caller, the method, the route template
 * (`/api/v1/bookings/:id`, never the literal URL, so `/X` and `/x/` share a
 * scope) and the path parameters, sorted by name.
 */
export function idempotencyScope(request: Request): string {
  const owner = request.user?.id ?? 'anonymous';
  const route = (request.route as { path?: unknown } | undefined)?.path;
  const template =
    typeof route === 'string'
      ? `${request.baseUrl}${route}`
      : `${request.baseUrl}${request.path}`;
  const params = Object.entries(request.params ?? {}).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const scope = `${owner}:${request.method}:${template}`;
  return params.length ? `${scope}:${JSON.stringify(params)}` : scope;
}

/** The claim each request holds, read by `@IdempotencyClaimParam()`. */
const claims = new WeakMap<Request, IdempotencyClaim>();

/**
 * Marks a route as requiring an `Idempotency-Key` header. A repeat with the
 * same key and body gets the first response again instead of running twice.
 * The handler takes `@IdempotencyClaimParam()` and calls
 * `markIdempotencyCommitted(tx, claim)` in the transaction that makes its
 * change; without that, a failure cannot tell "nothing happened" from
 * "something happened", and a slow request could run twice.
 */
export const Idempotent = () => SetMetadata(IDEMPOTENT, true);

/** The request's claim on its key, on an `@Idempotent()` route. */
export const IdempotencyClaimParam = createParamDecorator(
  (_: unknown, context: ExecutionContext): IdempotencyClaim => {
    const claim = claims.get(context.switchToHttp().getRequest<Request>());
    if (!claim) throw new Error('IdempotencyClaimParam needs @Idempotent()');
    return claim;
  },
);

type Outcome =
  { claim: IdempotencyClaim } | { replay: { status: number; body: unknown } };

/**
 * Keys live in PostgreSQL (`IdempotencyKey`), so losing Redis cannot let a
 * repeat through. States and what a repeat with the same key and body gets:
 *
 * - IN_PROGRESS, lock held: 409 with `Retry-After`.
 * - IN_PROGRESS, lock run out: the first request is presumed dead and the
 *   repeat takes the key over. Safe because nothing committed: the first
 *   request's `markIdempotencyCommitted` now matches nothing and rolls back.
 * - COMMITTED (changes made, response not stored yet): 409 with
 *   `Retry-After` while the lock holds; after that, as FAILED.
 * - COMPLETED: the stored response, with `Idempotent-Replayed: true`.
 * - FAILED (a server error, or any error after the changes committed):
 *   409 every time. Never
 *   replayed as a success and never run again; the client checks the
 *   outcome and uses a new key.
 * - Past `expiresAt` (24 hours): treated as unused.
 *
 * A refusal (4xx) before anything committed frees the key, so a corrected
 * retry can run. A server error keeps it as FAILED, committed or not: the
 * handler may already have called a provider.
 * The same key with a different body is 409 `IDEMPOTENCY_CONFLICT`.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly lockMs: number;
  /**
   * Keys the stored request hash (HMAC-SHA256), so a copy of the table
   * cannot be used to confirm a guess at what a request contained.
   */
  private readonly hashKey: Buffer;

  constructor(
    private readonly reflector: Reflector,
    private readonly store: IdempotencyStore,
    config: ConfigService,
  ) {
    this.lockMs = config.getOrThrow<number>('IDEMPOTENCY_LOCK_SECONDS') * 1000;
    this.hashKey = Buffer.from(
      hkdfSync(
        'sha256',
        Buffer.from(config.getOrThrow<string>('DATA_ENCRYPTION_KEY'), 'base64'),
        Buffer.alloc(0),
        HASH_KEY_INFO,
        32,
      ),
    );
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const required = this.reflector.getAllAndOverride<boolean | undefined>(
      IDEMPOTENT,
      [context.getHandler(), context.getClass()],
    );
    if (!required) return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    // Only a public route may share the "anonymous" scope. A signed-in
    // route without a user here is a wiring mistake (a guard missing or
    // reordered): refuse rather than let every caller share one scope.
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(
      IS_PUBLIC,
      [context.getHandler(), context.getClass()],
    );
    if (isPublic !== true && !request.user?.id) {
      throw new Error(
        '@Idempotent() on a route that is not @Public() needs a signed-in user; none was found, so the key would be shared by every caller.',
      );
    }

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
    const scope = idempotencyScope(request);
    const requestHash = createHmac('sha256', this.hashKey)
      .update(JSON.stringify(request.body ?? null))
      .digest('hex');

    return from(
      this.claim(scope, key.toLowerCase(), requestHash, response),
    ).pipe(
      switchMap((outcome) => {
        if ('replay' in outcome) {
          response.status(outcome.replay.status);
          response.setHeader('Idempotent-Replayed', 'true');
          return of(outcome.replay.body);
        }
        const { claim } = outcome;
        claims.set(request, claim);
        return next.handle().pipe(
          mergeMap(async (body: unknown) => {
            await this.store.complete(claim, response.statusCode, body);
            return body;
          }),
          catchError(async (error: unknown) => {
            const clientError =
              error instanceof HttpException && error.getStatus() < 500;
            await this.store.abandon(claim, clientError);
            throw error;
          }),
        );
      }),
    );
  }

  private async claim(
    scope: string,
    key: string,
    requestHash: string,
    response: Response,
  ): Promise<Outcome> {
    for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
      const now = Date.now();
      const lease: IdempotencyLease = {
        requestHash,
        ownerToken: randomUUID(),
        lockedUntil: new Date(now + this.lockMs),
        expiresAt: new Date(now + IDEMPOTENCY_WINDOW_SECONDS * 1000),
      };
      const id = await this.store.insert(scope, key, lease);
      if (id) return { claim: { id, ownerToken: lease.ownerToken } };

      const existing = await this.store.find(scope, key);
      // Freed by a failed first request between the two calls: claim again.
      if (!existing) continue;

      const expired = existing.expiresAt.getTime() <= now;
      if (!expired && existing.requestHash !== requestHash) {
        throw new AppException(
          'IDEMPOTENCY_CONFLICT',
          'This Idempotency-Key was already used with a different request.',
          HttpStatus.CONFLICT,
        );
      }
      const locked = existing.lockedUntil.getTime() > now;
      const status = existing.status;

      if (expired || (status === IdempotencyKeyStatus.IN_PROGRESS && !locked)) {
        if (await this.store.takeOver(existing.id, existing.ownerToken, lease))
          return { claim: { id: existing.id, ownerToken: lease.ownerToken } };
        continue;
      }
      if (status === IdempotencyKeyStatus.COMPLETED) {
        return {
          replay: {
            status: existing.responseStatus ?? HttpStatus.OK,
            body: existing.responseBody ?? undefined,
          },
        };
      }
      if (status === IdempotencyKeyStatus.FAILED || !locked) {
        throw new AppException(
          'IDEMPOTENCY_CONFLICT',
          'The first request with this Idempotency-Key failed after it may have taken effect. Check before sending it again with a new key.',
          HttpStatus.CONFLICT,
        );
      }
      break;
    }
    response.setHeader('Retry-After', '2');
    throw new AppException(
      'IDEMPOTENCY_CONFLICT',
      'The first request with this Idempotency-Key is still being processed. Retry shortly.',
      HttpStatus.CONFLICT,
    );
  }
}

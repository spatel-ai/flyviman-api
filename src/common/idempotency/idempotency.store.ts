import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { IdempotencyKeyStatus } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AppException } from '../errors/app.exception.js';
import { uniqueOrNull } from '../errors/unique.js';

/** A request's hold on its key. Every write after the claim names both. */
export interface IdempotencyClaim {
  id: string;
  ownerToken: string;
}

/** What the claim writes: a new row, or the fields a takeover replaces. */
export interface IdempotencyLease {
  requestHash: string;
  ownerToken: string;
  lockedUntil: Date;
  expiresAt: Date;
}

export interface IdempotencyRecord extends IdempotencyClaim {
  requestHash: string;
  status: IdempotencyKeyStatus;
  lockedUntil: Date;
  expiresAt: Date;
  responseStatus: number | null;
  responseBody: unknown;
}

/**
 * Durable idempotency keys. Every write is conditional, so two requests can
 * never both believe they own a key: the unique (scope, key) pair decides
 * the first claim, and the owner token decides everything after it.
 */
export abstract class IdempotencyStore {
  /** Inserts IN_PROGRESS; `null` when the key already exists in this scope. */
  abstract insert(
    scope: string,
    key: string,
    lease: IdempotencyLease,
  ): Promise<string | null>;

  abstract find(scope: string, key: string): Promise<IdempotencyRecord | null>;

  /**
   * Restarts the row as IN_PROGRESS under a new owner, only if its owner is
   * still `previousOwner`. For a lock that ran out or a key past its window.
   */
  abstract takeOver(
    id: string,
    previousOwner: string,
    lease: IdempotencyLease,
  ): Promise<boolean>;

  /** Stores the response, if this claim still owns the row. */
  abstract complete(
    claim: IdempotencyClaim,
    responseStatus: number,
    responseBody: unknown,
  ): Promise<void>;

  /**
   * After an error. A refusal (`clientError`, a 4xx) before anything
   * committed frees the key so a corrected retry can run. Anything else
   * keeps it as FAILED: a server error may follow a provider call or a
   * commit, and running it again could repeat that.
   */
  abstract abandon(
    claim: IdempotencyClaim,
    clientError: boolean,
  ): Promise<void>;

  /** Deletes keys whose window ended before `now`; returns how many. */
  abstract purgeExpired(now: Date): Promise<number>;
}

@Injectable()
export class PrismaIdempotencyStore extends IdempotencyStore {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async insert(scope: string, key: string, lease: IdempotencyLease) {
    const row = await uniqueOrNull(() =>
      this.prisma.idempotencyKey.create({
        data: {
          scope,
          key,
          ...lease,
          status: IdempotencyKeyStatus.IN_PROGRESS,
        },
        select: { id: true },
      }),
    );
    return row?.id ?? null;
  }

  async find(scope: string, key: string): Promise<IdempotencyRecord | null> {
    return this.prisma.idempotencyKey.findUnique({
      where: { scope_key: { scope, key } },
      select: {
        id: true,
        ownerToken: true,
        requestHash: true,
        status: true,
        lockedUntil: true,
        expiresAt: true,
        responseStatus: true,
        responseBody: true,
      },
    });
  }

  async takeOver(id: string, previousOwner: string, lease: IdempotencyLease) {
    const { count } = await this.prisma.idempotencyKey.updateMany({
      where: { id, ownerToken: previousOwner },
      data: {
        ...lease,
        status: IdempotencyKeyStatus.IN_PROGRESS,
        responseStatus: null,
        responseBody: Prisma.DbNull,
      },
    });
    return count === 1;
  }

  async complete(
    claim: IdempotencyClaim,
    responseStatus: number,
    responseBody: unknown,
  ) {
    await this.prisma.idempotencyKey.updateMany({
      where: {
        ...claim,
        status: {
          in: [
            IdempotencyKeyStatus.IN_PROGRESS,
            IdempotencyKeyStatus.COMMITTED,
          ],
        },
      },
      data: {
        status: IdempotencyKeyStatus.COMPLETED,
        responseStatus,
        responseBody:
          responseBody === undefined
            ? Prisma.DbNull
            : (responseBody as Prisma.InputJsonValue),
      },
    });
  }

  async abandon(claim: IdempotencyClaim, clientError: boolean) {
    if (clientError) {
      await this.prisma.idempotencyKey.deleteMany({
        where: { ...claim, status: IdempotencyKeyStatus.IN_PROGRESS },
      });
    }
    await this.prisma.idempotencyKey.updateMany({
      where: {
        ...claim,
        status: {
          in: [
            IdempotencyKeyStatus.IN_PROGRESS,
            IdempotencyKeyStatus.COMMITTED,
          ],
        },
      },
      data: { status: IdempotencyKeyStatus.FAILED },
    });
  }

  async purgeExpired(now: Date) {
    const { count } = await this.prisma.idempotencyKey.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    return count;
  }
}

/**
 * Marks the key COMMITTED inside the handler's own transaction, so the
 * record it creates and the key commit together or not at all. Every
 * `@Idempotent()` route calls it in the transaction that makes its change.
 * If another request took the key over (this one outran its lock), it
 * throws and the transaction rolls back: the change is made once.
 */
export async function markIdempotencyCommitted(
  tx: Prisma.TransactionClient,
  claim: IdempotencyClaim,
): Promise<void> {
  const { count } = await tx.idempotencyKey.updateMany({
    where: { ...claim, status: IdempotencyKeyStatus.IN_PROGRESS },
    data: { status: IdempotencyKeyStatus.COMMITTED },
  });
  if (count !== 1) {
    throw new AppException(
      'IDEMPOTENCY_CONFLICT',
      'This request took too long and its Idempotency-Key was handed to a retry. Nothing was changed.',
      HttpStatus.CONFLICT,
    );
  }
}

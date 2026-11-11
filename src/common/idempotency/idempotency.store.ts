import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS } from '../../redis/redis.module.js';

export interface IdempotencyRecord {
  /** Hash of the request body the key was first used with. */
  fingerprint: string;
  state: 'pending' | 'completed';
  status?: number;
  body?: unknown;
}

export abstract class IdempotencyStore {
  /**
   * Claims the key. Returns `null` when this caller now owns it, or the
   * record left by whoever claimed it first.
   */
  abstract begin(
    key: string,
    fingerprint: string,
    pendingTtlSeconds: number,
  ): Promise<IdempotencyRecord | null>;

  abstract complete(
    key: string,
    record: IdempotencyRecord,
    ttlSeconds: number,
  ): Promise<void>;

  /** Frees a key whose request failed, so the client can try again. */
  abstract release(key: string): Promise<void>;
}

@Injectable()
export class RedisIdempotencyStore extends IdempotencyStore {
  constructor(@Inject(REDIS) private readonly redis: Redis) {
    super();
  }

  async begin(
    key: string,
    fingerprint: string,
    pendingTtlSeconds: number,
  ): Promise<IdempotencyRecord | null> {
    const pending: IdempotencyRecord = { fingerprint, state: 'pending' };
    const claimed = await this.redis.set(
      key,
      JSON.stringify(pending),
      'EX',
      pendingTtlSeconds,
      'NX',
    );
    if (claimed === 'OK') return null;

    const existing = await this.redis.get(key);
    // The first request finished and expired between the two calls.
    if (existing === null)
      return this.begin(key, fingerprint, pendingTtlSeconds);
    return JSON.parse(existing) as IdempotencyRecord;
  }

  async complete(
    key: string,
    record: IdempotencyRecord,
    ttlSeconds: number,
  ): Promise<void> {
    await this.redis.set(key, JSON.stringify(record), 'EX', ttlSeconds);
  }

  async release(key: string): Promise<void> {
    await this.redis.del(key);
  }
}

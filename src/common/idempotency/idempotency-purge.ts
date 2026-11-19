import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import type { Redis } from 'ioredis';
import { REDIS } from '../../redis/redis.module.js';
import { IdempotencyStore } from './idempotency.store.js';

const LOCK_KEY = 'idempotency:purge:lock';
const LAST_RUN_KEY = 'idempotency:purge:last-run';
const LOCK_SECONDS = 10 * 60;
/** Deletes the lock only if it still holds this run's token. */
const RELEASE_LOCK = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/**
 * Deletes idempotency keys past their 24-hour window, daily, so the table
 * holds only keys that can still be replayed. An expired key is already
 * treated as unused, so deleting it changes no answer. One instance at a
 * time (the same Redis lock as the compliance job).
 */
@Injectable()
export class IdempotencyPurge implements OnApplicationBootstrap {
  private readonly logger = new Logger(IdempotencyPurge.name);

  constructor(
    private readonly store: IdempotencyStore,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly config: ConfigService,
  ) {}

  /**
   * A host that sleeps (the free Render instance) can miss the daily run;
   * on start-up the job runs if the last run is over 23 hours old. Not in
   * tests, which trigger it themselves.
   */
  onApplicationBootstrap(): void {
    if (this.config.get('NODE_ENV') === 'test') return;
    setTimeout(() => {
      void this.catchUp();
    }, 5_000).unref();
  }

  async catchUp(): Promise<void> {
    try {
      const last = await this.redis.get(LAST_RUN_KEY);
      if (last && Date.now() - Date.parse(last) < 23 * 3_600_000) return;
      await this.run();
    } catch (error) {
      this.logger.error(
        `Idempotency key purge catch-up failed: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
    }
  }

  /** Every day at 03:00 in India. */
  @Cron('30 21 * * *', { name: 'idempotency-key-purge', timeZone: 'UTC' })
  async daily(): Promise<void> {
    try {
      await this.run();
    } catch (error) {
      this.logger.error(
        `Idempotency key purge failed: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
    }
  }

  async run(now = new Date()): Promise<{ deleted: number; skipped: boolean }> {
    // The lock holds a token of this run, so only this run releases it.
    const token = randomUUID();
    const locked = await this.redis.set(
      LOCK_KEY,
      token,
      'EX',
      LOCK_SECONDS,
      'NX',
    );
    if (!locked) return { deleted: 0, skipped: true };
    try {
      const deleted = await this.store.purgeExpired(now);
      await this.redis.set(LAST_RUN_KEY, now.toISOString());
      if (deleted > 0) this.logger.log(`Idempotency keys purged: ${deleted}`);
      return { deleted, skipped: false };
    } finally {
      await this.redis.eval(RELEASE_LOCK, 1, LOCK_KEY, token);
    }
  }
}

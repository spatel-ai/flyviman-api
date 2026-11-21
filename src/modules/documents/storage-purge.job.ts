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
import { DocumentsService } from './documents.service.js';

const LOCK_KEY = 'documents:storage-purge:lock';
const LOCK_SECONDS = 10 * 60;
const BATCH = 500;
/** Deletes the lock only if it still holds this run's token. */
const RELEASE_LOCK = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/**
 * Retries the deletion of stored files whose metadata is gone (an erased
 * customer's medical documents, W5-8b) and that could not be deleted when
 * it committed: hourly and once on start-up, one instance at a time (Redis
 * lock, as the idempotency purge). Not on start-up in tests.
 */
@Injectable()
export class StoragePurgeJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(StoragePurgeJob.name);

  constructor(
    private readonly documents: DocumentsService,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.get('NODE_ENV') === 'test') return;
    setTimeout(() => {
      void this.scheduled();
    }, 5_000).unref();
  }

  @Cron('17 * * * *', { name: 'storage-purge' })
  async scheduled(): Promise<void> {
    try {
      await this.run();
    } catch (error) {
      this.logger.error(
        `Storage purge failed: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
    }
  }

  async run(): Promise<{ tried: number; left: number; skipped: boolean }> {
    const token = randomUUID();
    const locked = await this.redis.set(
      LOCK_KEY,
      token,
      'EX',
      LOCK_SECONDS,
      'NX',
    );
    if (!locked) return { tried: 0, left: 0, skipped: true };
    try {
      const { tried, left } = await this.documents.purgeQueued(BATCH);
      // Counts only: the queue's rows say which files are left.
      if (left > 0) {
        this.logger.error(`Storage purge: ${left} of ${tried} files left`);
      }
      return { tried, left, skipped: false };
    } finally {
      await this.redis.eval(RELEASE_LOCK, 1, LOCK_KEY, token);
    }
  }
}

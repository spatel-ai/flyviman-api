import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS } from '../../redis/redis.module.js';

export type AccountTokenPurpose = 'password-reset' | 'invitation';

export interface AccountToken {
  userId: string;
  purpose: AccountTokenPurpose;
}

/** Password reset links last 30 minutes; staff invitations 72 hours. */
export const ACCOUNT_TOKEN_TTL_SECONDS: Record<AccountTokenPurpose, number> = {
  'password-reset': 30 * 60,
  invitation: 72 * 60 * 60,
};

/**
 * Single-use, time-limited tokens emailed as links. Only a hash is kept, in
 * Redis, so a leaked store cannot be used to take over an account.
 */
@Injectable()
export class AccountTokensService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /**
   * A new link for the account. Only the newest link for a purpose works:
   * issuing one cancels the previous (D-070), so a re-sent invitation or a
   * second reset request leaves no older link usable.
   */
  async issue(userId: string, purpose: AccountTokenPurpose): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    const record: AccountToken = { userId, purpose };
    const ttl = ACCOUNT_TOKEN_TTL_SECONDS[purpose];
    const pointer = this.pointer(userId, purpose);
    const previous = await this.redis.get(pointer);
    const transaction = this.redis.multi();
    if (previous) transaction.del(previous);
    transaction
      .set(this.key(token), JSON.stringify(record), 'EX', ttl)
      .set(pointer, this.key(token), 'EX', ttl);
    await transaction.exec();
    return token;
  }

  /** Cancels the account's current link for a purpose, if any. */
  async revokeFor(userId: string, purpose: AccountTokenPurpose): Promise<void> {
    const pointer = this.pointer(userId, purpose);
    const current = await this.redis.get(pointer);
    if (current) await this.redis.del(current, pointer);
    else await this.redis.del(pointer);
  }

  /** Returns what the token stood for and destroys it, or `null`. */
  async consume(token: string): Promise<AccountToken | null> {
    const stored = await this.redis.getdel(this.key(token));
    return stored ? (JSON.parse(stored) as AccountToken) : null;
  }

  private pointer(userId: string, purpose: AccountTokenPurpose): string {
    return `account-token-current:${purpose}:${userId}`;
  }

  private key(token: string): string {
    return `account-token:${createHash('sha256').update(token).digest('hex')}`;
  }
}

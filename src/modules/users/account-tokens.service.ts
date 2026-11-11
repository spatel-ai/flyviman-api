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

  async issue(userId: string, purpose: AccountTokenPurpose): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    const record: AccountToken = { userId, purpose };
    await this.redis.set(
      this.key(token),
      JSON.stringify(record),
      'EX',
      ACCOUNT_TOKEN_TTL_SECONDS[purpose],
    );
    return token;
  }

  /** Returns what the token stood for and destroys it, or `null`. */
  async consume(token: string): Promise<AccountToken | null> {
    const stored = await this.redis.getdel(this.key(token));
    return stored ? (JSON.parse(stored) as AccountToken) : null;
  }

  private key(token: string): string {
    return `account-token:${createHash('sha256').update(token).digest('hex')}`;
  }
}

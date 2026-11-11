import { createHash } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { AppException } from '../../common/errors/app.exception.js';
import { REDIS } from '../../redis/redis.module.js';
import { normaliseEmail } from '../users/users.service.js';

/** Failed sign-ins for one email from one address before that pair is locked. */
export const LOGIN_MAX_FAILURES = 10;
/**
 * Failed sign-ins for one email from all addresses together. Much higher,
 * so that someone failing on purpose from one place cannot lock the owner
 * out, while guessing spread over many addresses is still stopped.
 */
export const LOGIN_MAX_FAILURES_ANY_ADDRESS = 100;
export const LOGIN_LOCK_SECONDS = 15 * 60;

const COUNT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n
`;

/**
 * Slows password guessing against one account. Counts by the email that was
 * entered, whether or not it has an account, so a lock reveals nothing.
 * Keys hold a hash of the email, never the address itself.
 */
@Injectable()
export class LoginFailures {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async assertNotLocked(
    email: string,
    ipAddress: string | null,
  ): Promise<void> {
    const [pair, any] = await this.redis.mget(
      this.pairKey(email, ipAddress),
      this.emailKey(email),
    );
    if (
      Number(pair ?? 0) >= LOGIN_MAX_FAILURES ||
      Number(any ?? 0) >= LOGIN_MAX_FAILURES_ANY_ADDRESS
    ) {
      throw new AppException(
        'RATE_LIMITED',
        'Too many failed attempts. Try again later or reset your password.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  async record(email: string, ipAddress: string | null): Promise<void> {
    await this.redis.eval(
      COUNT,
      1,
      this.pairKey(email, ipAddress),
      LOGIN_LOCK_SECONDS,
    );
    await this.redis.eval(COUNT, 1, this.emailKey(email), LOGIN_LOCK_SECONDS);
  }

  /** After a successful sign-in from this address. */
  async clear(email: string, ipAddress: string | null): Promise<void> {
    await this.redis.del(this.pairKey(email, ipAddress));
  }

  /** After a password reset: the owner has proven themselves by email. */
  async clearAll(email: string): Promise<void> {
    const pattern = `${this.emailKey(email)}:*`;
    const keys = await this.redis.keys(pattern);
    await this.redis.del(this.emailKey(email), ...keys);
  }

  private emailKey(email: string): string {
    const digest = createHash('sha256')
      .update(normaliseEmail(email))
      .digest('hex')
      .slice(0, 32);
    return `login-failures:${digest}`;
  }

  private pairKey(email: string, ipAddress: string | null): string {
    return `${this.emailKey(email)}:${ipAddress ?? 'unknown'}`;
  }
}

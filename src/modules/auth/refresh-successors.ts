import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { FieldCipher } from '../../common/crypto/field-cipher.js';
import { REDIS } from '../../redis/redis.module.js';
import type { SessionTokens } from './auth.cookies.js';

/**
 * How many racing requests may be handed the same successor pair. A page's
 * link prefetches each reach the web proxy, so after an idle spell one
 * refresh token is presented once per portal link in view (eight on the
 * admin portal) plus the page itself, and again by runtime prefetches. 20
 * covers that with room, while still bounding a replayed token.
 */
export const REFRESH_REPLAY_MAX = 20;

/** Counts a hand-out and returns the pair, or nothing once used up or gone. */
const TAKE = `
if redis.call('EXISTS', KEYS[1]) == 0 then return false end
local served = redis.call('HINCRBY', KEYS[1], 'served', 1)
if served > tonumber(ARGV[1]) then return false end
return redis.call('HGET', KEYS[1], 'pair')
`;

/**
 * The token pair a refresh issued, kept for the rotation grace period so a
 * request that lost the race with it receives the same pair instead of a
 * refusal (D-036, D-111). Never a new pair: that would fork the sign-in.
 * Keyed by the hash of the retired refresh token and encrypted at rest.
 * Redis errors are thrown; the caller decides what they mean.
 */
@Injectable()
export class RefreshSuccessors {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly cipher: FieldCipher,
  ) {}

  async keep(
    retiredHash: string,
    tokens: SessionTokens,
    ttlMs: number,
  ): Promise<void> {
    await this.redis
      .multi()
      .hset(
        this.key(retiredHash),
        'pair',
        this.cipher.encrypt(JSON.stringify(tokens)),
      )
      .pexpire(this.key(retiredHash), ttlMs)
      .exec();
  }

  /** The kept pair, at most `REFRESH_REPLAY_MAX` times, or `null`. */
  async take(retiredHash: string): Promise<SessionTokens | null> {
    const sealed = (await this.redis.eval(
      TAKE,
      1,
      this.key(retiredHash),
      REFRESH_REPLAY_MAX,
    )) as string | null;
    return sealed
      ? (JSON.parse(this.cipher.decrypt(sealed)) as SessionTokens)
      : null;
  }

  async forget(retiredHash: string): Promise<void> {
    await this.redis.del(this.key(retiredHash));
  }

  private key(retiredHash: string): string {
    return `refresh-successor:${retiredHash}`;
  }
}

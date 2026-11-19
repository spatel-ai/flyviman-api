import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS } from '../../redis/redis.module.js';

/** Window of the per-sign-in rotation cap. */
export const ROTATION_WINDOW_MS = 60_000;

const COUNT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return n
`;

/**
 * Counts the rotations of one sign-in (session family) in a fixed window,
 * so a stolen live token cannot be rotated without bound: each rotation is
 * a new token, which the per-token rate limit never sees twice.
 * Redis errors are thrown; the caller decides what they mean.
 */
@Injectable()
export class RefreshRotations {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** Counts one rotation of the family and returns the count in the window. */
  async count(familyId: string): Promise<number> {
    return Number(
      await this.redis.eval(
        COUNT,
        1,
        `refresh-rotations:${familyId}`,
        ROTATION_WINDOW_MS,
      ),
    );
  }
}

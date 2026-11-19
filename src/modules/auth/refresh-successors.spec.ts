import type { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { FieldCipher } from '../../common/crypto/field-cipher.js';
import { REFRESH_REPLAY_MAX, RefreshSuccessors } from './refresh-successors.js';

const PAIR = {
  accessToken: 'access-jwt',
  refreshToken: 'refresh-secret',
  csrfToken: 'csrf-secret',
};

function setup() {
  const stored = new Map<string, string>();
  const chain = {
    hset: vi.fn((key: string, _field: string, value: string) => {
      stored.set(key, value);
      return chain;
    }),
    pexpire: vi.fn(() => chain),
    exec: vi.fn().mockResolvedValue([]),
  };
  const redis = {
    multi: () => chain,
    eval: vi.fn(),
    del: vi.fn(),
  };
  const cipher = new FieldCipher({
    getOrThrow: () => Buffer.alloc(32, 7).toString('base64'),
  } as unknown as ConfigService);
  const successors = new RefreshSuccessors(redis as unknown as Redis, cipher);
  return { successors, redis, chain, stored };
}

describe('RefreshSuccessors', () => {
  it('keeps the pair encrypted, under the old token hash, for the grace period', async () => {
    const { successors, chain, stored } = setup();

    await successors.keep('old-hash', PAIR, 10_000);

    const sealed = stored.get('refresh-successor:old-hash');
    expect(sealed).toBeDefined();
    for (const secret of Object.values(PAIR)) {
      expect(sealed).not.toContain(secret);
    }
    expect(chain.pexpire).toHaveBeenCalledWith(
      'refresh-successor:old-hash',
      10_000,
    );
  });

  it('hands the kept pair back, counted against the replay limit', async () => {
    const { successors, redis, stored } = setup();
    await successors.keep('old-hash', PAIR, 10_000);
    redis.eval.mockResolvedValue(stored.get('refresh-successor:old-hash'));

    await expect(successors.take('old-hash')).resolves.toEqual(PAIR);
    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      'refresh-successor:old-hash',
      REFRESH_REPLAY_MAX,
    );
  });

  it('answers nothing when the pair is gone or used up', async () => {
    const { successors, redis } = setup();
    redis.eval.mockResolvedValue(null);
    await expect(successors.take('old-hash')).resolves.toBeNull();
  });

  it('refuses a value that was tampered with', async () => {
    const { successors, redis } = setup();
    redis.eval.mockResolvedValue('v1.AAAA.BBBB.CCCC');
    await expect(successors.take('old-hash')).rejects.toThrow();
  });
});

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
    redis.eval.mockResolvedValue([stored.get('refresh-successor:old-hash'), 1]);

    await expect(successors.take('old-hash')).resolves.toEqual({
      tokens: PAIR,
      first: true,
    });
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
    redis.eval.mockResolvedValue(['v1.AAAA.BBBB.CCCC', 1]);
    await expect(successors.take('old-hash')).rejects.toThrow();
  });
});

describe('RefreshSuccessors replay limit', () => {
  it(`hands the pair out ${REFRESH_REPLAY_MAX} times, then refuses`, async () => {
    const { successors, redis, stored } = setup();
    await successors.keep('old-hash', PAIR, 10_000);
    // The TAKE script's behaviour, over the stored hash.
    let served = 0;
    redis.eval.mockImplementation(
      async (_script: string, _keys: number, key: string, max: number) => {
        if (!stored.has(key)) return null;
        served += 1;
        return served > max ? null : [stored.get(key), served === 1 ? 1 : 0];
      },
    );

    const results = [];
    for (let attempt = 0; attempt <= REFRESH_REPLAY_MAX; attempt += 1) {
      results.push(await successors.take('old-hash'));
    }
    expect(REFRESH_REPLAY_MAX).toBe(20);
    expect(results.map((result) => result?.tokens)).toEqual([
      ...Array(REFRESH_REPLAY_MAX).fill(PAIR),
      undefined,
    ]);
    // Only the first hand-out of the rotation is marked for the audit.
    expect(results.filter((result) => result?.first)).toHaveLength(1);
    expect(results[REFRESH_REPLAY_MAX]).toBeNull();
  });
});

describe('RefreshSuccessors first hand-out', () => {
  it('marks a later hand-out of the same rotation as not the first', async () => {
    const { successors, redis, stored } = setup();
    await successors.keep('old-hash', PAIR, 10_000);
    redis.eval.mockResolvedValue([stored.get('refresh-successor:old-hash'), 0]);
    await expect(successors.take('old-hash')).resolves.toEqual({
      tokens: PAIR,
      first: false,
    });
  });

  it('sets the flag in the same script that counts the hand-out', async () => {
    const { successors, redis } = setup();
    redis.eval.mockResolvedValue(null);
    await successors.take('old-hash');
    const [script] = redis.eval.mock.calls[0] as [string];
    expect(script).toContain("HSETNX', KEYS[1], 'audited'");
  });
});

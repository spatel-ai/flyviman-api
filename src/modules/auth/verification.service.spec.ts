import type { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import type { NotificationsService } from '../notifications/notifications.service.js';
import {
  type VerificationPurpose,
  VerificationService,
} from './verification.service.js';

/**
 * An in-memory stand-in for the Redis calls the service makes: SET, GET,
 * DEL and its two scripts (take a guess with two keys, count with one).
 */
function fakeRedis() {
  const values = new Map<string, string>();
  const redis = {
    set: vi.fn((key: string, value: string) => {
      values.set(key, value);
      return Promise.resolve('OK');
    }),
    get: vi.fn((key: string) => Promise.resolve(values.get(key) ?? null)),
    del: vi.fn((...keys: string[]) =>
      Promise.resolve(keys.filter((key) => values.delete(key)).length),
    ),
    eval: vi.fn((_script: string, keyCount: number, ...args: unknown[]) => {
      const bump = (key: string) => {
        const next = Number(values.get(key) ?? 0) + 1;
        values.set(key, String(next));
        return next;
      };
      if (keyCount === 2) {
        const [attemptKey, guessKey, max] = args as [string, string, number];
        const attempt = values.get(attemptKey);
        if (!attempt) return Promise.resolve(null);
        const guesses = bump(guessKey);
        if (guesses > Number(max)) {
          values.delete(attemptKey);
          return Promise.resolve(null);
        }
        return Promise.resolve([attempt, guesses]);
      }
      return Promise.resolve(bump(args[0] as string));
    }),
  };
  return { redis, values };
}

function setup() {
  const { redis, values } = fakeRedis();
  const sent: string[] = [];
  const notifications = {
    send: vi.fn((input: { variables?: { code?: string } }) => {
      if (input.variables?.code) sent.push(input.variables.code);
      return Promise.resolve();
    }),
  };
  const settings: Record<string, unknown> = {
    JWT_ACCESS_SECRET: 'test-secret-for-codes',
    OTP_RESEND_COOLDOWN_SECONDS: 0,
    OTP_MAX_PER_HOUR: 5,
  };
  const config = {
    getOrThrow: (key: string) => settings[key],
  } as unknown as ConfigService;
  const service = new VerificationService(
    redis as unknown as Redis,
    notifications as unknown as NotificationsService,
    config,
  );
  /** Starts an attempt for the user and returns its id and the code sent. */
  async function codeFor(purpose?: VerificationPurpose) {
    const { verificationId } = await service.start(
      { phone: '+919800000000' },
      { userId: 'user-1', purpose },
    );
    return { verificationId, code: sent[sent.length - 1] };
  }
  return { service, values, sent, codeFor };
}

describe('VerificationService purposes (W5-8b)', () => {
  it('accepts an erasure code for erasure, once', async () => {
    const { service, codeFor } = setup();
    const { verificationId, code } = await codeFor('erasure');

    await expect(
      service.check(verificationId, code, 'erasure'),
    ).resolves.toMatchObject({ userId: 'user-1', pending: null });
    await expect(
      service.check(verificationId, code, 'erasure'),
    ).rejects.toMatchObject({ code: 'AUTH_OTP_EXPIRED' });
  });

  it('refuses an erasure code on the sign-in check, and leaves it unused', async () => {
    const { service, codeFor } = setup();
    const { verificationId, code } = await codeFor('erasure');

    // POST /auth/otp/verify checks with the default purpose.
    await expect(service.check(verificationId, code)).rejects.toMatchObject({
      code: 'AUTH_OTP_EXPIRED',
    });
    // Still good for what it was sent for.
    await expect(
      service.check(verificationId, code, 'erasure'),
    ).resolves.toMatchObject({ userId: 'user-1' });
  });

  it('refuses a sign-in code on the erasure check', async () => {
    const { service, codeFor } = setup();
    const { verificationId, code } = await codeFor();

    await expect(
      service.check(verificationId, code, 'erasure'),
    ).rejects.toMatchObject({ code: 'AUTH_OTP_EXPIRED' });
    await expect(service.check(verificationId, code)).resolves.toMatchObject({
      userId: 'user-1',
    });
  });

  it('keeps the purpose when the code is sent again', async () => {
    const { service, sent, codeFor } = setup();
    const { verificationId } = await codeFor('erasure');
    // POST /auth/otp/request with the verificationId sends a fresh code.
    await service.resend(verificationId);
    const fresh = sent[sent.length - 1];

    await expect(service.check(verificationId, fresh)).rejects.toMatchObject({
      code: 'AUTH_OTP_EXPIRED',
    });
    await expect(
      service.check(verificationId, fresh, 'erasure'),
    ).resolves.toMatchObject({ userId: 'user-1' });
  });

  it('treats an attempt stored without a purpose as sign-in', async () => {
    const { service, values, codeFor } = setup();
    const { verificationId, code } = await codeFor();
    const key = `otp:${verificationId}`;
    const stored = JSON.parse(values.get(key)!) as Record<string, unknown>;
    expect(stored).not.toHaveProperty('purpose');

    await expect(
      service.check(verificationId, code, 'erasure'),
    ).rejects.toMatchObject({ code: 'AUTH_OTP_EXPIRED' });
    await expect(service.check(verificationId, code)).resolves.toBeDefined();
  });
});

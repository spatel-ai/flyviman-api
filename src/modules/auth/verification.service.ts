import {
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { AppException } from '../../common/errors/app.exception.js';
import { REDIS } from '../../redis/redis.module.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import {
  Identifier,
  normaliseEmail,
  UserAccount,
} from '../users/users.service.js';

/** One-time codes are six digits and last five minutes (security-rbac.md). */
export const OTP_TTL_SECONDS = 5 * 60;
/** Wrong guesses allowed on one code before it is destroyed. */
export const OTP_MAX_ATTEMPTS = 5;
/** Wrong guesses allowed against one address in an hour, across all codes. */
export const OTP_MAX_FAILURES_PER_HOUR = 20;

/**
 * What a registration will create once its code is verified. Nothing is
 * written to the database before then, so an unverified registration can
 * neither occupy an address nor be completed by anyone but the browser that
 * started it.
 */
export interface PendingRegistration {
  kind: string;
  [field: string]: unknown;
}

/** Creates the account for a verified registration; `null` if it no longer can. */
export type RegistrationCompletion = (
  pending: PendingRegistration,
  identifier: Identifier,
) => Promise<UserAccount | null>;

interface Attempt {
  address: string;
  /** Existing user the code signs in. */
  userId: string | null;
  /** Registration to complete. */
  pending: PendingRegistration | null;
  /** `null` when no code was sent: the attempt can never succeed. */
  hash: string | null;
}

export interface VerifiedAttempt {
  identifier: Identifier;
  userId: string | null;
  pending: PendingRegistration | null;
}

export interface VerificationSent {
  /** Opaque handle for this attempt; needed, with the code, to verify. */
  verificationId: string;
  channel: 'EMAIL' | 'SMS';
  destination: string;
  expiresInSeconds: number;
}

function address(identifier: Identifier): string {
  return 'email' in identifier
    ? `email:${normaliseEmail(identifier.email)}`
    : `phone:${identifier.phone}`;
}

function identifierOf(stored: string): Identifier {
  const value = stored.slice(stored.indexOf(':') + 1);
  return stored.startsWith('email:') ? { email: value } : { phone: value };
}

/** Hides most of an address for display: `a***@example.com`, `+91******3210`. */
export function mask(identifier: Identifier): string {
  if ('email' in identifier) {
    const [local, domain] = normaliseEmail(identifier.email).split('@');
    return `${local.slice(0, 1)}***@${domain}`;
  }
  const { phone } = identifier;
  return `${phone.slice(0, 3)}${'*'.repeat(Math.max(phone.length - 7, 2))}${phone.slice(-4)}`;
}

/**
 * Counts a guess and returns the attempt, in one step, so concurrent guesses
 * cannot each see a fresh counter. KEYS: attempt, counter. ARGV: max, ttl.
 */
const TAKE_GUESS = `
local attempt = redis.call('GET', KEYS[1])
if not attempt then return false end
local guesses = redis.call('INCR', KEYS[2])
if guesses == 1 then redis.call('EXPIRE', KEYS[2], ARGV[2]) end
if guesses > tonumber(ARGV[1]) then
  redis.call('DEL', KEYS[1], KEYS[2])
  return false
end
return { attempt, guesses }
`;

/** INCR with an expiry set in the same step. KEYS: counter. ARGV: ttl. */
const COUNT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n
`;

/**
 * Issues and checks one-time codes. A code belongs to one verification
 * attempt, identified by an opaque ID that only the browser which started
 * the attempt holds; knowing the address and seeing a code is not enough.
 * Codes are kept only as a keyed hash in Redis and are never logged by this
 * service or stored in the notification log. (The development messaging
 * mock prints what it would have sent; it cannot run in production.)
 */
@Injectable()
export class VerificationService {
  private readonly secret: string;
  private readonly completions = new Map<string, RegistrationCompletion>();

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {
    this.secret = `otp:${config.getOrThrow<string>('JWT_ACCESS_SECRET')}`;
  }

  /** Registered by the module that owns the records a registration creates. */
  registerCompletion(kind: string, complete: RegistrationCompletion): void {
    this.completions.set(kind, complete);
  }

  completionFor(kind: string): RegistrationCompletion {
    const complete = this.completions.get(kind);
    if (!complete) throw new Error(`No registration handler for "${kind}"`);
    return complete;
  }

  /**
   * Enforces the per-address sending limits. Call it before deciding whether
   * an account exists, so the limits behave the same either way and reveal
   * nothing about registration. `scope` keeps unrelated flows (codes,
   * password resets) from using up each other's allowance.
   */
  async throttle(identifier: Identifier, scope = 'otp'): Promise<void> {
    const id = `${scope}:${address(identifier)}`;
    const cooldown = this.config.getOrThrow<number>(
      'OTP_RESEND_COOLDOWN_SECONDS',
    );
    if (cooldown > 0) {
      const fresh = await this.redis.set(
        `send-cooldown:${id}`,
        '1',
        'EX',
        cooldown,
        'NX',
      );
      if (fresh !== 'OK') throw this.tooMany(cooldown);
    }
    const sent = Number(
      await this.redis.eval(COUNT, 1, `send-count:${id}`, 3600),
    );
    if (sent > this.config.getOrThrow<number>('OTP_MAX_PER_HOUR')) {
      throw this.tooMany(3600);
    }
    // Too many wrong guesses pause code sending for the address. Only for
    // codes: it must never block password recovery.
    if (scope !== 'otp') return;
    const failures = Number(
      (await this.redis.get(`otp-failures:${address(identifier)}`)) ?? 0,
    );
    if (failures >= OTP_MAX_FAILURES_PER_HOUR) throw this.tooMany(3600);
  }

  /**
   * Starts a verification attempt and, when there is something to verify,
   * sends its code. With neither `userId` nor `pending` nothing is sent and
   * the attempt can never succeed, but it looks the same from outside.
   */
  async start(
    identifier: Identifier,
    target: { userId?: string; pending?: PendingRegistration } = {},
  ): Promise<VerificationSent> {
    const verificationId = randomBytes(24).toString('base64url');
    const attempt: Attempt = {
      address: address(identifier),
      userId: target.userId ?? null,
      pending: target.pending ?? null,
      hash: null,
    };
    await this.issue(verificationId, attempt);
    return this.sent(verificationId, identifier);
  }

  /**
   * Sends a fresh code for an attempt that is still open. The ID is known
   * only to the browser that started the attempt, so saying that it has
   * expired reveals nothing to anyone else.
   */
  async resend(verificationId: string): Promise<VerificationSent> {
    const stored = await this.redis.get(this.key(verificationId));
    if (!stored) throw this.expired();
    const attempt = JSON.parse(stored) as Attempt;
    const identifier = identifierOf(attempt.address);
    await this.throttle(identifier);
    await this.issue(verificationId, attempt);
    return this.sent(verificationId, identifier);
  }

  /**
   * Checks a code against its attempt. A code works once, and five wrong
   * guesses destroy it.
   */
  async check(verificationId: string, code: string): Promise<VerifiedAttempt> {
    const key = this.key(verificationId);
    const taken = (await this.redis.eval(
      TAKE_GUESS,
      2,
      key,
      `${key}:guesses`,
      OTP_MAX_ATTEMPTS,
      OTP_TTL_SECONDS,
    )) as [string, number] | null;
    if (!taken) throw this.expired();

    const [stored, guesses] = taken;
    const attempt = JSON.parse(stored) as Attempt;
    const expected = Buffer.from(attempt.hash ?? '');
    const given = Buffer.from(this.hash(verificationId, code));
    const matches =
      expected.length === given.length && timingSafeEqual(expected, given);

    if (!matches) {
      // Counted only against a code that was really sent. Otherwise anyone
      // could run up the count for an address by "registering" it.
      if (attempt.hash) {
        await this.redis.eval(
          COUNT,
          1,
          `otp-failures:${attempt.address}`,
          3600,
        );
      }
      if (guesses >= OTP_MAX_ATTEMPTS) {
        await this.redis.del(key, `${key}:guesses`);
        throw this.expired();
      }
      throw new AppException(
        'AUTH_OTP_INVALID',
        'That code is not correct.',
        HttpStatus.BAD_REQUEST,
      );
    }

    // Only the request that removes the attempt may use it.
    if ((await this.redis.del(key)) !== 1) throw this.expired();
    await this.redis.del(`${key}:guesses`);
    return {
      identifier: identifierOf(attempt.address),
      userId: attempt.userId,
      pending: attempt.pending,
    };
  }

  expired(): AppException {
    return new AppException(
      'AUTH_OTP_EXPIRED',
      'That code has expired. Request a new one.',
      HttpStatus.BAD_REQUEST,
    );
  }

  private async issue(verificationId: string, attempt: Attempt): Promise<void> {
    const key = this.key(verificationId);
    const eligible = attempt.userId !== null || attempt.pending !== null;
    const code = eligible
      ? randomInt(0, 1_000_000).toString().padStart(6, '0')
      : null;
    await this.redis.set(
      key,
      JSON.stringify({
        ...attempt,
        hash: code ? this.hash(verificationId, code) : null,
      }),
      'EX',
      OTP_TTL_SECONDS,
    );
    await this.redis.del(`${key}:guesses`);
    if (!code) return;

    const identifier = identifierOf(attempt.address);
    await this.notifications.send({
      // A registration has no user yet; its message is sent but not logged.
      userId: attempt.userId ?? undefined,
      channel: 'email' in identifier ? 'EMAIL' : 'SMS',
      templateKey: 'auth.verification_code',
      to: 'email' in identifier ? identifier.email : identifier.phone,
      secret: true,
      variables: { code, minutes: OTP_TTL_SECONDS / 60 },
    });
  }

  private sent(
    verificationId: string,
    identifier: Identifier,
  ): VerificationSent {
    return {
      verificationId,
      channel: 'email' in identifier ? 'EMAIL' : 'SMS',
      destination: mask(identifier),
      expiresInSeconds: OTP_TTL_SECONDS,
    };
  }

  private key(verificationId: string): string {
    return `otp:${verificationId}`;
  }

  private hash(verificationId: string, code: string): string {
    return createHmac('sha256', this.secret)
      .update(`${verificationId}:${code}`)
      .digest('hex');
  }

  private tooMany(retryAfterSeconds: number): AppException {
    return new AppException(
      'RATE_LIMITED',
      'Too many attempts. Try again later.',
      HttpStatus.TOO_MANY_REQUESTS,
      [{ field: 'retryAfterSeconds', issue: String(retryAfterSeconds) }],
    );
  }
}

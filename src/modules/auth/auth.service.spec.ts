import { ConfigService } from '@nestjs/config';
import { Role, UserStatus } from '../../generated/prisma/enums.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { AuditService } from '../audit/audit.service.js';
import type { UsersService } from '../users/users.service.js';
import { AuthService } from './auth.service.js';
import type { LoginFailures } from './login-failures.js';
import type { RefreshRotations } from './refresh-rotations.js';
import type { RefreshSuccessors } from './refresh-successors.js';
import { hashPassword } from '../../common/crypto/password.js';
import type { TokenService } from './token.service.js';

const CLIENT = { userAgent: 'vitest', ipAddress: '127.0.0.1' };
const GRACE_SECONDS = 10;
const ROTATIONS_PER_MINUTE = 30;

function setup() {
  const session = {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
  const failures = {
    assertNotLocked: vi.fn(),
    record: vi.fn(),
    clear: vi.fn(),
  };
  const users = {
    findCredentialsByEmail: vi.fn(),
    findAccount: vi.fn(),
    recordLogin: vi.fn(),
  };
  const audit = { record: vi.fn() };
  const tokens = {
    cookieSettings: { refreshTtlSeconds: 3600 },
    signAccessToken: vi.fn().mockResolvedValue('access'),
    randomToken: vi.fn().mockReturnValue('random'),
    hashToken: (token: string) => `hash:${token}`,
  };
  const config = {
    getOrThrow: (name: string) =>
      name === 'REFRESH_ROTATIONS_PER_MINUTE'
        ? ROTATIONS_PER_MINUTE
        : GRACE_SECONDS,
  };
  const successors = {
    keep: vi.fn().mockResolvedValue(undefined),
    take: vi.fn().mockResolvedValue(null),
    forget: vi.fn().mockResolvedValue(undefined),
  };
  const rotations = { count: vi.fn().mockResolvedValue(1) };
  const service = new AuthService(
    {
      session,
      $transaction: (run: (tx: unknown) => unknown) => run({ session }),
    } as unknown as PrismaService,
    users as unknown as UsersService,
    tokens as unknown as TokenService,
    audit as unknown as AuditService,
    config as unknown as ConfigService,
    failures as unknown as LoginFailures,
    successors as unknown as RefreshSuccessors,
    rotations as unknown as RefreshRotations,
  );
  // Replays check the account; it is active unless a test says otherwise.
  users.findAccount.mockResolvedValue(ACTIVE);
  return { service, session, users, audit, failures, successors, rotations };
}

const ACTIVE = {
  id: 'user-1',
  email: 'a@b.test',
  phone: null,
  role: Role.CUSTOMER,
  status: UserStatus.ACTIVE,
};

function storedSession(overrides: object = {}) {
  return {
    id: 'session-1',
    userId: 'user-1',
    familyId: 'family-1',
    revokedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

describe('AuthService.login', () => {
  it('refuses an account that is not yet verified with the generic answer', async () => {
    const { service, users, session } = setup();
    users.findCredentialsByEmail.mockResolvedValue({
      id: 'user-1',
      passwordHash: await hashPassword('correct horse battery'),
      role: Role.CUSTOMER,
      status: UserStatus.PENDING_VERIFICATION,
    });
    await expect(
      service.login('a@b.test', 'correct horse battery', CLIENT),
    ).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });
    expect(session.create).not.toHaveBeenCalled();
  });

  it('refuses an account that has no password', async () => {
    const { service, users } = setup();
    users.findCredentialsByEmail.mockResolvedValue({
      id: 'user-1',
      passwordHash: null,
      role: Role.CUSTOMER,
      status: UserStatus.ACTIVE,
    });
    await expect(service.login('a@b.test', '', CLIENT)).rejects.toMatchObject({
      code: 'AUTH_INVALID_CREDENTIALS',
    });
  });

  it('does not reveal a suspension to someone with the wrong password', async () => {
    const { service, users } = setup();
    users.findCredentialsByEmail.mockResolvedValue({
      id: 'user-1',
      passwordHash: await hashPassword('correct horse battery'),
      role: Role.CUSTOMER,
      status: UserStatus.SUSPENDED,
    });
    await expect(
      service.login('a@b.test', 'wrong', CLIENT),
    ).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });
  });

  it('counts a failed attempt against the email', async () => {
    const { service, users, failures } = setup();
    users.findCredentialsByEmail.mockResolvedValue(null);
    await expect(
      service.login('a@b.test', 'wrong', CLIENT),
    ).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });
    expect(failures.record).toHaveBeenCalledWith('a@b.test', '127.0.0.1');
  });

  it('does not check the password while the email is locked', async () => {
    const { service, users, failures } = setup();
    failures.assertNotLocked.mockRejectedValue(new Error('locked'));
    await expect(service.login('a@b.test', 'x', CLIENT)).rejects.toThrow(
      'locked',
    );
    expect(users.findCredentialsByEmail).not.toHaveBeenCalled();
  });
});

describe('AuthService.refresh', () => {
  it('rotates within the same family and stores only the hash', async () => {
    const { service, session, users } = setup();
    session.findUnique.mockResolvedValue(storedSession());
    users.findAccount.mockResolvedValue(ACTIVE);

    const tokens = await service.refresh('old', CLIENT);

    expect(session.findUnique).toHaveBeenCalledWith({
      where: { refreshTokenHash: 'hash:old' },
    });
    expect(session.updateMany).toHaveBeenCalledWith({
      where: { id: 'session-1', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(session.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        familyId: 'family-1',
        refreshTokenHash: 'hash:random',
      }),
    });
    expect(tokens.refreshToken).toBe('random');
  });

  it('refuses an expired token', async () => {
    const { service, session } = setup();
    session.findUnique.mockResolvedValue(
      storedSession({ expiresAt: new Date(Date.now() - 1) }),
    );
    await expect(service.refresh('old', CLIENT)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });

  it('refuses a just-rotated token with nothing to replay, without ending the sign-in', async () => {
    const { service, session, audit, successors } = setup();
    session.findUnique.mockResolvedValue(
      storedSession({ revokedAt: new Date(Date.now() - 1_000) }),
    );
    session.findFirst.mockResolvedValue({ id: 'session-2' });
    // Expired, used up, or never kept: the store answers nothing.
    successors.take.mockResolvedValue(null);
    await expect(service.refresh('old', CLIENT)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    expect(successors.take).toHaveBeenCalledWith('hash:old');
    expect(session.updateMany).not.toHaveBeenCalled();
    expect(session.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('ends the whole family when a rotated token is replayed later', async () => {
    const { service, session, audit } = setup();
    session.findUnique.mockResolvedValue(
      storedSession({
        revokedAt: new Date(Date.now() - (GRACE_SECONDS + 1) * 1000),
      }),
    );
    await expect(service.refresh('old', CLIENT)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    expect(session.updateMany).toHaveBeenCalledWith({
      where: { familyId: 'family-1', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.refresh_reuse_detected' }),
    );
  });

  it('lets only one of two concurrent requests claim the token', async () => {
    const { service, session, users } = setup();
    session.findUnique.mockResolvedValue(storedSession());
    users.findAccount.mockResolvedValue(ACTIVE);
    session.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.refresh('old', CLIENT)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    expect(session.create).not.toHaveBeenCalled();
  });

  it('ends the sign-in of a user who has been suspended', async () => {
    const { service, session, users } = setup();
    session.findUnique.mockResolvedValue(storedSession());
    users.findAccount.mockResolvedValue({
      ...ACTIVE,
      status: UserStatus.SUSPENDED,
    });
    await expect(service.refresh('old', CLIENT)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    expect(session.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { familyId: 'family-1', revokedAt: null },
      }),
    );
  });
});

describe('AuthService.refresh, racing requests (D-111)', () => {
  const PAIR = {
    accessToken: 'winner-access',
    refreshToken: 'winner-refresh',
    csrfToken: 'winner-csrf',
  };

  it('keeps the new pair for the grace period, under the old token', async () => {
    const { service, session, users, successors } = setup();
    session.findUnique.mockResolvedValue(storedSession());
    users.findAccount.mockResolvedValue(ACTIVE);

    const tokens = await service.refresh('old', CLIENT);

    expect(successors.keep).toHaveBeenCalledWith(
      'hash:old',
      tokens,
      GRACE_SECONDS * 1000,
    );
  });

  it('hands a request within the grace period the same pair, and audits it', async () => {
    const { service, session, audit, successors } = setup();
    session.findUnique.mockResolvedValue(
      storedSession({ revokedAt: new Date(Date.now() - 1_000) }),
    );
    session.findFirst.mockResolvedValue({ id: 'session-2' });
    successors.take.mockResolvedValue({ tokens: PAIR, first: true });

    await expect(service.refresh('old', CLIENT)).resolves.toEqual(PAIR);
    // Never a new pair, and the sign-in is not ended.
    expect(session.create).not.toHaveBeenCalled();
    expect(session.updateMany).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith({
      action: 'auth.refresh_replayed',
      entityType: 'User',
      entityId: 'user-1',
      actor: null,
    });
  });

  it("hands the loser of a concurrent claim the winner's pair", async () => {
    const { service, session, users, successors } = setup();
    session.findUnique.mockResolvedValue(storedSession());
    users.findAccount.mockResolvedValue(ACTIVE);
    session.updateMany.mockResolvedValue({ count: 0 });
    session.findFirst.mockResolvedValue({ id: 'session-2' });
    successors.take.mockResolvedValue({ tokens: PAIR, first: true });

    await expect(service.refresh('old', CLIENT)).resolves.toEqual(PAIR);
    expect(session.create).not.toHaveBeenCalled();
    expect(successors.keep).not.toHaveBeenCalled();
  });

  it('never replays after the grace period: the sign-in is ended as before', async () => {
    const { service, session, successors } = setup();
    session.findUnique.mockResolvedValue(
      storedSession({
        revokedAt: new Date(Date.now() - GRACE_SECONDS * 1000),
      }),
    );
    successors.take.mockResolvedValue({ tokens: PAIR, first: true });

    await expect(service.refresh('old', CLIENT)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    expect(successors.take).not.toHaveBeenCalled();
    expect(session.updateMany).toHaveBeenCalledWith({
      where: { familyId: 'family-1', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('refuses once the sign-in has ended, without using a replay', async () => {
    const { service, session, successors } = setup();
    session.findUnique.mockResolvedValue(
      storedSession({ revokedAt: new Date(Date.now() - 1_000) }),
    );
    session.findFirst.mockResolvedValue(null);
    successors.take.mockResolvedValue({ tokens: PAIR, first: true });

    await expect(service.refresh('old', CLIENT)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    expect(successors.take).not.toHaveBeenCalled();
  });

  it('refuses an unknown token without looking for a replay', async () => {
    const { service, session, successors } = setup();
    session.findUnique.mockResolvedValue(null);

    await expect(service.refresh('made-up', CLIENT)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    expect(successors.take).not.toHaveBeenCalled();
  });

  describe('with Redis down', () => {
    it('still renews the winner', async () => {
      const { service, session, users, successors } = setup();
      session.findUnique.mockResolvedValue(storedSession());
      users.findAccount.mockResolvedValue(ACTIVE);
      successors.keep.mockRejectedValue(new Error('connection refused'));

      await expect(service.refresh('old', CLIENT)).resolves.toMatchObject({
        refreshToken: 'random',
      });
    });

    it('still renews the winner when Redis hangs', async () => {
      const { service, session, users, successors } = setup();
      session.findUnique.mockResolvedValue(storedSession());
      users.findAccount.mockResolvedValue(ACTIVE);
      successors.keep.mockReturnValue(new Promise(() => undefined));

      await expect(service.refresh('old', CLIENT)).resolves.toMatchObject({
        refreshToken: 'random',
      });
    });

    it('refuses a racing request when Redis hangs', async () => {
      const { service, session, successors } = setup();
      session.findUnique.mockResolvedValue(
        storedSession({ revokedAt: new Date(Date.now() - 1_000) }),
      );
      session.findFirst.mockResolvedValue({ id: 'session-2' });
      successors.take.mockReturnValue(new Promise(() => undefined));

      await expect(service.refresh('old', CLIENT)).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });
      expect(session.updateMany).not.toHaveBeenCalled();
    });

    it('refuses a racing request, without ending the sign-in', async () => {
      const { service, session, audit, successors } = setup();
      session.findUnique.mockResolvedValue(
        storedSession({ revokedAt: new Date(Date.now() - 1_000) }),
      );
      session.findFirst.mockResolvedValue({ id: 'session-2' });
      successors.take.mockRejectedValue(new Error('connection refused'));

      await expect(service.refresh('old', CLIENT)).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });
      expect(session.updateMany).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });
  });
});

describe('AuthService.isRefreshInPlay (rate limit, D-111)', () => {
  it.each([
    ['a live token', null, true],
    ['a token rotated moments ago', 1_000, true],
    ['a token retired past the grace period', GRACE_SECONDS * 1000, false],
  ])('%s', async (_name, revokedAgoMs, expected) => {
    const { service, session } = setup();
    session.findUnique.mockResolvedValue({
      revokedAt:
        revokedAgoMs === null ? null : new Date(Date.now() - revokedAgoMs),
    });
    await expect(service.isRefreshInPlay('old')).resolves.toBe(expected);
  });

  it('an unknown token', async () => {
    const { service, session } = setup();
    session.findUnique.mockResolvedValue(null);
    await expect(service.isRefreshInPlay('made-up')).resolves.toBe(false);
  });
});

describe('AuthService.refresh, replay audit and suspension', () => {
  const PAIR = {
    accessToken: 'winner-access',
    refreshToken: 'winner-refresh',
    csrfToken: 'winner-csrf',
  };

  function racing() {
    const context = setup();
    context.session.findUnique.mockResolvedValue(
      storedSession({ revokedAt: new Date(Date.now() - 1_000) }),
    );
    context.session.findFirst.mockResolvedValue({ id: 'session-2' });
    return context;
  }

  it('audits only the first hand-out of a rotation', async () => {
    const { service, audit, successors } = racing();
    successors.take.mockResolvedValue({ tokens: PAIR, first: false });

    await expect(service.refresh('old', CLIENT)).resolves.toEqual(PAIR);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it.each([UserStatus.SUSPENDED, UserStatus.PENDING_VERIFICATION])(
    'refuses to replay to a %s user and ends the sign-in',
    async (status) => {
      const { service, session, users, successors } = racing();
      users.findAccount.mockResolvedValue({ ...ACTIVE, status });
      successors.take.mockResolvedValue({ tokens: PAIR, first: true });

      await expect(service.refresh('old', CLIENT)).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });
      expect(successors.take).not.toHaveBeenCalled();
      expect(session.updateMany).toHaveBeenCalledWith({
        where: { familyId: 'family-1', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    },
  );

  it('refuses to replay to a deleted user', async () => {
    const { service, users, successors } = racing();
    users.findAccount.mockResolvedValue(null);
    await expect(service.refresh('old', CLIENT)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    expect(successors.take).not.toHaveBeenCalled();
  });
});

describe('AuthService.refresh, rotations per sign-in', () => {
  it('counts each rotation against the sign-in', async () => {
    const { service, session, rotations } = setup();
    session.findUnique.mockResolvedValue(storedSession());
    rotations.count.mockResolvedValue(ROTATIONS_PER_MINUTE);

    await expect(service.refresh('old', CLIENT)).resolves.toMatchObject({
      refreshToken: 'random',
    });
    expect(rotations.count).toHaveBeenCalledWith('family-1');
  });

  it('refuses a rotation over the limit with 429, leaving the token live', async () => {
    const { service, session, rotations } = setup();
    session.findUnique.mockResolvedValue(storedSession());
    rotations.count.mockResolvedValue(ROTATIONS_PER_MINUTE + 1);

    const error = await service.refresh('old', CLIENT).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'RATE_LIMITED' });
    expect((error as { getStatus(): number }).getStatus()).toBe(429);
    // Not claimed, not revoked: it works again after the minute.
    expect(session.updateMany).not.toHaveBeenCalled();
    expect(session.create).not.toHaveBeenCalled();
  });

  it('allows the rotation when Redis cannot count it', async () => {
    const { service, session, rotations } = setup();
    session.findUnique.mockResolvedValue(storedSession());
    rotations.count.mockRejectedValue(new Error('connection refused'));

    await expect(service.refresh('old', CLIENT)).resolves.toMatchObject({
      refreshToken: 'random',
    });
  });

  it('does not count replays or refused tokens', async () => {
    const { service, session, successors, rotations } = setup();
    session.findUnique.mockResolvedValue(
      storedSession({ revokedAt: new Date(Date.now() - 1_000) }),
    );
    session.findFirst.mockResolvedValue({ id: 'session-2' });
    successors.take.mockResolvedValue(null);
    await service.refresh('old', CLIENT).catch(() => undefined);
    session.findUnique.mockResolvedValue(null);
    await service.refresh('made-up', CLIENT).catch(() => undefined);
    expect(rotations.count).not.toHaveBeenCalled();
  });
});

describe('AuthService.isRefreshKnown (rate limit)', () => {
  it.each([
    ['a token with a session', { id: 'session-1' }, true],
    ['a made-up token', null, false],
  ])('%s', async (_name, row, expected) => {
    const { service, session } = setup();
    session.findUnique.mockResolvedValue(row);
    await expect(service.isRefreshKnown('token')).resolves.toBe(expected);
    expect(session.findUnique).toHaveBeenCalledWith({
      where: { refreshTokenHash: 'hash:token' },
      select: { id: true },
    });
  });
});

import { ConfigService } from '@nestjs/config';
import { Role, UserStatus } from '../../generated/prisma/enums.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { AuditService } from '../audit/audit.service.js';
import type { UsersService } from '../users/users.service.js';
import { AuthService } from './auth.service.js';
import type { LoginFailures } from './login-failures.js';
import { hashPassword } from '../../common/crypto/password.js';
import type { TokenService } from './token.service.js';

const CLIENT = { userAgent: 'vitest', ipAddress: '127.0.0.1' };
const GRACE_SECONDS = 10;

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
  const config = { getOrThrow: () => GRACE_SECONDS };
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
  );
  return { service, session, users, audit, failures };
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

  it('refuses a just-rotated token without ending the sign-in', async () => {
    const { service, session, audit } = setup();
    session.findUnique.mockResolvedValue(
      storedSession({ revokedAt: new Date(Date.now() - 1_000) }),
    );
    await expect(service.refresh('old', CLIENT)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    expect(session.updateMany).not.toHaveBeenCalled();
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

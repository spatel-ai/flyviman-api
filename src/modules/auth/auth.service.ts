import { randomUUID } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException } from '../../common/errors/app.exception.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { Role, UserStatus } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { UserAccount, UsersService } from '../users/users.service.js';
import type { SessionTokens } from './auth.cookies.js';
import { LoginFailures } from './login-failures.js';
import { hashPassword, verifyPassword } from '../../common/crypto/password.js';
import { TokenService } from './token.service.js';

export interface ClientInfo {
  userAgent: string | null;
  ipAddress: string | null;
}

function invalidCredentials(): AppException {
  return new AppException(
    'AUTH_INVALID_CREDENTIALS',
    'The email or password is not correct.',
    HttpStatus.UNAUTHORIZED,
  );
}

function unauthenticated(): AppException {
  return new AppException(
    'UNAUTHENTICATED',
    'Sign in to continue.',
    HttpStatus.UNAUTHORIZED,
  );
}

/** Sign-in, token rotation and sign-out. Owns the Session table. */
@Injectable()
export class AuthService {
  /** Verified when the email is unknown, so both cases take the same time. */
  private readonly decoyHash = hashPassword(randomUUID());

  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly failures: LoginFailures,
  ) {}

  async login(
    email: string,
    password: string,
    client: ClientInfo,
  ): Promise<{ tokens: SessionTokens; user: UserAccount }> {
    await this.failures.assertNotLocked(email, client.ipAddress);
    const credentials = await this.users.findCredentialsByEmail(email);
    const passwordMatches = await verifyPassword(
      credentials?.passwordHash ?? (await this.decoyHash),
      password,
    );
    // Same answer for an unknown email, a wrong password, and an account
    // that is not yet verified, so the response never confirms an account.
    if (
      !credentials?.passwordHash ||
      !passwordMatches ||
      credentials.status === UserStatus.PENDING_VERIFICATION
    ) {
      await this.failures.record(email, client.ipAddress);
      throw invalidCredentials();
    }
    await this.failures.clear(email, client.ipAddress);
    if (credentials.status === UserStatus.SUSPENDED) {
      throw new AppException(
        'AUTH_ACCOUNT_SUSPENDED',
        'This account is suspended. Contact support.',
        HttpStatus.FORBIDDEN,
      );
    }

    const user = await this.users.findAccount(credentials.id);
    if (!user) throw invalidCredentials();
    return { tokens: await this.startSession(user, client), user };
  }

  /**
   * Begins a new sign-in for a user whose identity has just been proven
   * (password or one-time code), and records it.
   */
  async startSession(
    user: { id: string; role: Role },
    client: ClientInfo,
  ): Promise<SessionTokens> {
    const tokens = await this.issue(user.id, randomUUID(), client);
    await this.users.recordLogin(user.id);
    await this.audit.record({
      action: 'auth.login',
      entityType: 'User',
      entityId: user.id,
      actor: { id: user.id, role: user.role },
    });
    return tokens;
  }

  /** Signs the user out everywhere, for example after a password change. */
  async revokeAllSessions(
    userId: string,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    await db.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Exchanges a refresh token for a new pair. Each token works once. */
  async refresh(
    refreshToken: string | undefined,
    client: ClientInfo,
  ): Promise<SessionTokens> {
    if (!refreshToken) throw unauthenticated();

    const session = await this.prisma.session.findUnique({
      where: { refreshTokenHash: this.tokens.hashToken(refreshToken) },
    });
    if (!session) throw unauthenticated();

    if (session.revokedAt) {
      // A rotated token presented again within the grace period is treated
      // as two requests racing (two tabs, or the web server and the browser):
      // it is refused but the sign-in survives. After that it is treated as
      // stolen, and every session descended from that sign-in is ended.
      const graceMs =
        this.config.getOrThrow<number>('REFRESH_ROTATION_GRACE_SECONDS') * 1000;
      const age = Date.now() - session.revokedAt.getTime();
      if (age >= graceMs) {
        await this.revokeFamily(session.familyId);
        await this.audit.record({
          action: 'auth.refresh_reuse_detected',
          entityType: 'User',
          entityId: session.userId,
          actor: null,
        });
      }
      throw unauthenticated();
    }
    if (session.expiresAt.getTime() <= Date.now()) throw unauthenticated();

    const user = await this.users.findAccount(session.userId);
    if (!user || user.status !== UserStatus.ACTIVE) {
      await this.revokeFamily(session.familyId);
      throw unauthenticated();
    }

    // Retiring the old token and creating the new one happen together, so
    // the sign-in is never without a live token. Only one of two concurrent
    // requests can claim the old one.
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.session.updateMany({
        where: { id: session.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (claimed.count !== 1) throw unauthenticated();
      return this.issue(user.id, session.familyId, client, tx);
    });
  }

  /**
   * Ends the sign-in on every tab that shares it. Identified by the access
   * token if it is still valid, otherwise by the refresh token, so signing
   * out works after the access token has expired. Always succeeds: with
   * neither, there is nothing to end.
   */
  async logout(tokens: {
    accessToken?: string;
    refreshToken?: string;
  }): Promise<void> {
    const claims = tokens.accessToken
      ? await this.tokens.verifyAccessToken(tokens.accessToken)
      : null;
    let familyId = claims?.sid;
    let userId = claims?.sub;
    if (!familyId && tokens.refreshToken) {
      const session = await this.prisma.session.findUnique({
        where: { refreshTokenHash: this.tokens.hashToken(tokens.refreshToken) },
        select: { familyId: true, userId: true },
      });
      familyId = session?.familyId;
      userId = session?.userId;
    }
    if (!familyId || !userId) return;

    await this.revokeFamily(familyId);
    const account = await this.users.findAccount(userId);
    await this.audit.record({
      action: 'auth.logout',
      entityType: 'User',
      entityId: userId,
      actor: account ? { id: account.id, role: account.role } : null,
    });
  }

  /** True while the sign-in has at least one refresh token still in force. */
  async isFamilyActive(familyId: string): Promise<boolean> {
    const live = await this.prisma.session.findFirst({
      where: { familyId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true },
    });
    return live !== null;
  }

  private async issue(
    userId: string,
    familyId: string,
    client: ClientInfo,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<SessionTokens> {
    const refreshToken = this.tokens.randomToken();
    const { refreshTtlSeconds } = this.tokens.cookieSettings;
    await db.session.create({
      data: {
        userId,
        familyId,
        refreshTokenHash: this.tokens.hashToken(refreshToken),
        userAgent: client.userAgent?.slice(0, 500) ?? null,
        ipAddress: client.ipAddress,
        expiresAt: new Date(Date.now() + refreshTtlSeconds * 1000),
      },
    });
    return {
      accessToken: await this.tokens.signAccessToken({
        sub: userId,
        sid: familyId,
      }),
      refreshToken,
      csrfToken: this.tokens.randomToken(),
    };
  }

  private async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}

import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Paginated } from '../../common/dto/paginated.js';
import { AppException } from '../../common/errors/app.exception.js';
import { uniqueOrNull } from '../../common/errors/unique.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { Role, UserStatus } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import {
  ACCOUNT_TOKEN_TTL_SECONDS,
  AccountTokensService,
} from './account-tokens.service.js';

export interface UserCredentials {
  id: string;
  passwordHash: string | null;
  role: Role;
  status: UserStatus;
}

export interface UserAccount {
  id: string;
  email: string | null;
  phone: string | null;
  role: Role;
  status: UserStatus;
}

export type UserDetail = Prisma.UserGetPayload<{
  omit: { passwordHash: true };
}>;

/** Roles that are internal staff. */
export const STAFF_ROLES: Role[] = [
  Role.OPS,
  Role.FINANCE_ADMIN,
  Role.SUPER_ADMIN,
];

export type Identifier = { email: string } | { phone: string };

const ACCOUNT = {
  id: true,
  email: true,
  phone: true,
  role: true,
  status: true,
} as const;

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

function where(identifier: Identifier): Prisma.UserWhereUniqueInput {
  return 'email' in identifier
    ? { email: normaliseEmail(identifier.email) }
    : { phone: identifier.phone };
}

function notFound(): AppException {
  return new AppException('NOT_FOUND', 'User not found.', HttpStatus.NOT_FOUND);
}

/** Owns the User table. Other modules read users only through this service. */
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tokens: AccountTokensService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  /** For sign-in only: the one place a password hash leaves the table. */
  findCredentialsByEmail(email: string): Promise<UserCredentials | null> {
    return this.prisma.user.findUnique({
      where: { email: normaliseEmail(email) },
      select: { id: true, passwordHash: true, role: true, status: true },
    });
  }

  findAccount(id: string): Promise<UserAccount | null> {
    return this.prisma.user.findUnique({ where: { id }, select: ACCOUNT });
  }

  findAccountBy(
    identifier: Identifier,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<UserAccount | null> {
    return db.user.findUnique({ where: where(identifier), select: ACCOUNT });
  }

  create(
    data: {
      email?: string;
      phone?: string;
      passwordHash?: string;
      role: Role;
      /** The address was proven with a one-time code: the account is active. */
      verified?: boolean;
    },
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<UserAccount> {
    const now = new Date();
    return db.user.create({
      data: {
        email: data.email ? normaliseEmail(data.email) : null,
        phone: data.phone ?? null,
        passwordHash: data.passwordHash ?? null,
        role: data.role,
        status: data.verified
          ? UserStatus.ACTIVE
          : UserStatus.PENDING_VERIFICATION,
        emailVerifiedAt: data.verified && data.email ? now : null,
        phoneVerifiedAt: data.verified && data.phone ? now : null,
      },
      select: ACCOUNT,
    });
  }

  async setPassword(
    id: string,
    passwordHash: string,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    await db.user.update({ where: { id }, data: { passwordHash } });
  }

  /**
   * Marks the identifier as verified. This is the only way an account leaves
   * PENDING_VERIFICATION; a suspended account stays suspended.
   */
  async markVerified(
    id: string,
    channel: 'email' | 'phone',
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<{ account: UserAccount; activated: boolean }> {
    const current = await db.user.findUniqueOrThrow({
      where: { id },
      select: { status: true },
    });
    const activated = current.status === UserStatus.PENDING_VERIFICATION;
    const now = new Date();
    const account = await db.user.update({
      where: { id },
      data: {
        ...(channel === 'email'
          ? { emailVerifiedAt: now }
          : { phoneVerifiedAt: now }),
        ...(activated ? { status: UserStatus.ACTIVE } : {}),
      },
      select: ACCOUNT,
    });
    return { account, activated };
  }

  async recordLogin(id: string): Promise<void> {
    await this.prisma.user.update({
      where: { id },
      data: { lastLoginAt: new Date() },
    });
  }

  // --- Administration -----------------------------------------------------

  async list(filter: {
    page: number;
    pageSize: number;
    role?: Role;
    status?: UserStatus;
    q?: string;
  }): Promise<Paginated<UserDetail>> {
    const where: Prisma.UserWhereInput = {
      role: filter.role,
      status: filter.status,
      ...(filter.q
        ? {
            OR: [
              { email: { contains: filter.q.trim(), mode: 'insensitive' } },
              { phone: { contains: filter.q.trim() } },
            ],
          }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        omit: { passwordHash: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (filter.page - 1) * filter.pageSize,
        take: filter.pageSize,
      }),
      this.prisma.user.count({ where }),
    ]);
    return new Paginated(items, filter.page, filter.pageSize, total);
  }

  async getDetail(id: string): Promise<UserDetail> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      omit: { passwordHash: true },
    });
    if (!user) throw notFound();
    return user;
  }

  /**
   * The one place an administrator changes a user's status. Allowed:
   * ACTIVE to SUSPENDED and back. Writes the audit record in the same
   * transaction. Suspension takes effect on the user's next request.
   */
  async setStatus(
    actor: AuthUser,
    id: string,
    status: UserStatus,
    reason: string,
  ): Promise<UserDetail> {
    if (actor.id === id) {
      throw new AppException(
        'USER_INVALID_TRANSITION',
        'You cannot change the status of your own account.',
        HttpStatus.CONFLICT,
      );
    }
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id } });
      if (!user) throw notFound();

      const allowed =
        (user.status === UserStatus.ACTIVE &&
          status === UserStatus.SUSPENDED) ||
        (user.status === UserStatus.SUSPENDED && status === UserStatus.ACTIVE);
      if (!allowed) {
        throw new AppException(
          'USER_INVALID_TRANSITION',
          `A user cannot go from ${user.status} to ${status}.`,
          HttpStatus.CONFLICT,
        );
      }

      const updated = await tx.user.update({
        where: { id },
        data: { status },
        omit: { passwordHash: true },
      });
      await this.audit.record(
        {
          action:
            status === UserStatus.SUSPENDED ? 'user.suspend' : 'user.reinstate',
          entityType: 'User',
          entityId: id,
          before: { status: user.status },
          after: { status },
          reason,
        },
        tx,
      );
      return updated;
    });
  }

  /**
   * Creates an internal account with no password and emails a single-use
   * link to choose one. The account becomes active when the link is used.
   * Calling it again for an account that is still waiting sends a new link
   * (and applies the role given), so a lost or expired invitation is not a
   * dead end.
   */
  async createStaff(email: string, role: Role): Promise<UserDetail> {
    const normalised = normaliseEmail(email);
    const inUse = () =>
      new AppException(
        'USER_ALREADY_EXISTS',
        'An account with this email already exists.',
        HttpStatus.CONFLICT,
        [{ field: 'email', issue: 'is already in use' }],
      );

    const user = await uniqueOrNull(() =>
      this.prisma.$transaction(async (tx) => {
        const existing = await tx.user.findUnique({
          where: { email: normalised },
        });
        if (existing) {
          const waiting =
            existing.status === UserStatus.PENDING_VERIFICATION &&
            STAFF_ROLES.includes(existing.role);
          if (!waiting) throw inUse();
          const updated = await tx.user.update({
            where: { id: existing.id },
            data: { role },
            omit: { passwordHash: true },
          });
          await this.audit.record(
            {
              action: 'staff.reinvite',
              entityType: 'User',
              entityId: existing.id,
              before: { role: existing.role },
              after: { role },
            },
            tx,
          );
          return updated;
        }
        const created = await tx.user.create({
          data: {
            email: normalised,
            role,
            status: UserStatus.PENDING_VERIFICATION,
          },
          omit: { passwordHash: true },
        });
        await this.audit.record(
          {
            action: 'staff.create',
            entityType: 'User',
            entityId: created.id,
            after: { role },
          },
          tx,
        );
        return created;
      }),
    );
    if (!user) throw inUse();

    const token = await this.tokens.issue(user.id, 'invitation');
    await this.notifications.send({
      userId: user.id,
      channel: 'EMAIL',
      templateKey: 'staff.invitation',
      to: normalised,
      secret: true,
      variables: {
        link: this.passwordLink(token),
        hours: ACCOUNT_TOKEN_TTL_SECONDS.invitation / 3600,
      },
    });
    return user;
  }

  // --- For operator staff (operators module) --------------------------------

  /**
   * Returns an account to the invited state: no password, waiting for its
   * invitation link. Used when an operator invites someone whose earlier
   * staff membership was removed.
   */
  async resetToInvited(
    id: string,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<UserAccount> {
    return db.user.update({
      where: { id },
      data: { status: UserStatus.PENDING_VERIFICATION, passwordHash: null },
      select: ACCOUNT,
    });
  }

  /** Sets an account's status; the caller audits the action it belongs to. */
  async changeStatus(
    id: string,
    status: UserStatus,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    await db.user.update({ where: { id }, data: { status } });
  }

  /** What a team list shows of each account. */
  async summaries(ids: string[]): Promise<
    Map<
      string,
      {
        email: string | null;
        role: Role;
        status: UserStatus;
        lastLoginAt: Date | null;
        createdAt: Date;
      }
    >
  > {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        lastLoginAt: true,
        createdAt: true,
      },
    });
    return new Map(rows.map(({ id, ...rest }) => [id, rest]));
  }

  /** The web page where a reset or invitation token is exchanged. */
  passwordLink(token: string): string {
    const origin = this.config.getOrThrow<string>('WEB_ORIGIN');
    return `${origin}/reset-password?token=${encodeURIComponent(token)}`;
  }
}

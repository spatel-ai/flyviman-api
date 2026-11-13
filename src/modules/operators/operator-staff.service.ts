import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { AppException } from '../../common/errors/app.exception.js';
import { uniqueOrNull } from '../../common/errors/unique.js';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  OperatorStatus,
  Role,
  SuspensionSource,
  UserStatus,
} from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { REDIS } from '../../redis/redis.module.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { AuthService } from '../auth/auth.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import {
  ACCOUNT_TOKEN_TTL_SECONDS,
  AccountTokensService,
} from '../users/account-tokens.service.js';
import { normaliseEmail, UsersService } from '../users/users.service.js';
import type { StaffStatus } from './dto/operator-staff.dto.js';
import {
  assertAdmin,
  type Capability,
  parsePermissions,
  type StaffPermissions,
} from './operator-access.js';
import { OperatorsService } from './operators.service.js';

/** Invitations one operator may send in an hour (D-068). */
export const MAX_INVITES_PER_HOUR = 20;

export interface StaffMember {
  id: string;
  email: string | null;
  status: StaffStatus;
  /** While suspended: Flyviman (only it can lift that) or the operator. */
  suspendedBy: 'PLATFORM' | 'OPERATOR' | null;
  permissions: StaffPermissions;
  invitedAt: Date;
  lastLoginAt: Date | null;
}

export interface PermissionsInput {
  capabilities: Capability[];
  allAircraft: boolean;
  aircraftIds: string[];
}

function staffStatus(status: UserStatus): StaffStatus {
  if (status === UserStatus.PENDING_VERIFICATION) return 'INVITED';
  return status === UserStatus.ACTIVE ? 'ACTIVE' : 'SUSPENDED';
}

function notFound(): AppException {
  return new AppException(
    'NOT_FOUND',
    'Staff member not found.',
    HttpStatus.NOT_FOUND,
  );
}

function inUse(): AppException {
  return new AppException(
    'USER_ALREADY_EXISTS',
    'This email cannot be invited: it already belongs to an account.',
    HttpStatus.CONFLICT,
    [{ field: 'email', issue: 'is already in use' }],
  );
}

function invalidTransition(message: string): AppException {
  return new AppException(
    'USER_INVALID_TRANSITION',
    message,
    HttpStatus.CONFLICT,
  );
}

/**
 * An operator's own staff (M3 step 7, D-049, D-068): invitations,
 * permissions, suspension and removal, by the operator's administrators.
 * Owns the staff side of OperatorMember; accounts are written through
 * UsersService.
 */
@Injectable()
export class OperatorStaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly operators: OperatorsService,
    private readonly users: UsersService,
    private readonly tokens: AccountTokensService,
    private readonly auth: AuthService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async list(user: AuthUser): Promise<StaffMember[]> {
    const { access } = await this.operators.accessFor(user);
    assertAdmin(access);
    const members = await this.prisma.operatorMember.findMany({
      where: { operatorId: access.operatorId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const accounts = await this.users.summaries(
      members.map((member) => member.userId),
    );
    return members.flatMap((member) => {
      const account = accounts.get(member.userId);
      if (!account || account.role !== Role.OPERATOR_STAFF) return [];
      return [
        {
          id: member.id,
          email: account.email,
          status: staffStatus(account.status),
          suspendedBy: account.suspendedBy,
          permissions: parsePermissions(member.permissions),
          invitedAt: member.createdAt,
          lastLoginAt: account.lastLoginAt,
        },
      ];
    });
  }

  /**
   * Invites someone to the operator's staff, or re-sends a pending
   * invitation (and applies the permissions given). An address that belongs
   * to any other account is refused; one whose earlier staff membership was
   * removed is invited afresh, with its password cleared.
   */
  async invite(
    user: AuthUser,
    input: PermissionsInput & { email: string },
  ): Promise<StaffMember> {
    const { operator, access } = await this.operators.accessFor(user);
    assertAdmin(access);
    if (operator.status !== OperatorStatus.APPROVED) {
      throw new AppException(
        'OPERATOR_NOT_APPROVED',
        'Only an approved operator can invite staff.',
        HttpStatus.CONFLICT,
      );
    }
    const permissions = await this.checked(operator.id, input);
    await this.countInvite(operator.id);
    const email = normaliseEmail(input.email);

    const result = await uniqueOrNull(() =>
      this.prisma.$transaction(async (tx) => {
        const existing = await this.users.findAccountBy({ email }, tx);
        if (!existing) {
          const created = await this.users.create(
            { email, role: Role.OPERATOR_STAFF },
            tx,
          );
          const member = await tx.operatorMember.create({
            data: {
              operatorId: operator.id,
              userId: created.id,
              permissions: { ...permissions },
            },
          });
          await this.record(tx, 'operator_staff.invite', member.id, {
            after: { userId: created.id, ...permissions },
          });
          return { userId: created.id, memberId: member.id };
        }

        if (existing.role !== Role.OPERATOR_STAFF) throw inUse();
        const membership = await tx.operatorMember.findUnique({
          where: { userId: existing.id },
        });
        if (membership && membership.operatorId !== operator.id) throw inUse();

        if (membership) {
          // Already on this team: only a pending invitation can be re-sent.
          if (existing.status !== UserStatus.PENDING_VERIFICATION) {
            throw new AppException(
              'USER_ALREADY_EXISTS',
              'This person is already on your team.',
              HttpStatus.CONFLICT,
              [{ field: 'email', issue: 'is already a member' }],
            );
          }
          // A concurrent removal leaves nothing to update: refuse, not 500.
          const { count } = await tx.operatorMember.updateMany({
            where: { id: membership.id, operatorId: operator.id },
            data: { permissions: { ...permissions } },
          });
          if (count !== 1) throw inUse();
          await this.record(tx, 'operator_staff.reinvite', membership.id, {
            before: parsePermissions(membership.permissions),
            after: permissions,
          });
          return { userId: existing.id, memberId: membership.id };
        }

        // A staff account whose earlier membership was removed. Only an
        // operator's own removal can be undone this way; an account Flyviman
        // suspended stays suspended (D-070).
        const suspension = await this.users.suspensionOf(existing.id, tx);
        if (
          suspension.status !== UserStatus.SUSPENDED ||
          suspension.suspendedBy !== SuspensionSource.OPERATOR
        ) {
          throw inUse();
        }
        await this.users.resetToInvited(existing.id, tx);
        await this.auth.revokeAllSessions(existing.id, tx);
        const member = await tx.operatorMember.create({
          data: {
            operatorId: operator.id,
            userId: existing.id,
            permissions: { ...permissions },
          },
        });
        await this.record(tx, 'operator_staff.invite', member.id, {
          after: { userId: existing.id, ...permissions, returning: true },
        });
        return { userId: existing.id, memberId: member.id };
      }),
    );
    if (!result) throw inUse();

    const token = await this.tokens.issue(result.userId, 'invitation');
    await this.notifications.send({
      userId: result.userId,
      channel: 'EMAIL',
      templateKey: 'operator.staff_invitation',
      to: email,
      secret: true,
      variables: {
        operatorName: operator.tradingName ?? operator.legalName,
        link: this.users.passwordLink(token),
        hours: ACCOUNT_TOKEN_TTL_SECONDS.invitation / 3600,
      },
    });
    return this.member(access.operatorId, result.memberId);
  }

  /**
   * Changes a staff member's permissions, or suspends or reinstates them.
   * Suspending signs them out everywhere at once. A pending invitation is
   * withdrawn with remove, not suspended. Only an operator's own suspension
   * can be lifted here; one by Flyviman cannot (D-070). The member row is
   * locked and every check made inside the transaction, so two changes at
   * once cannot overwrite each other.
   */
  async update(
    user: AuthUser,
    memberId: string,
    changes: Partial<PermissionsInput> & {
      status?: 'ACTIVE' | 'SUSPENDED';
      reason?: string;
    },
  ): Promise<StaffMember> {
    const { access } = await this.operators.accessFor(user);
    assertAdmin(access);
    // Fails fast (404) for a member out of reach; re-read under lock below.
    await this.staffMember(access.operatorId, memberId);
    const reason = changes.reason?.trim();
    if (changes.status === 'SUSPENDED' && (!reason || reason.length < 3)) {
      throw new AppException(
        'VALIDATION_ERROR',
        'Give a reason for the suspension.',
        HttpStatus.BAD_REQUEST,
        [{ field: 'reason', issue: 'must be at least 3 characters' }],
      );
    }
    const touchesPermissions =
      changes.capabilities !== undefined ||
      changes.allAircraft !== undefined ||
      changes.aircraftIds !== undefined;

    const outcome = await this.prisma.$transaction(async (tx) => {
      const member = await this.lockedMember(tx, access.operatorId, memberId);
      const account = await this.users.suspensionOf(member.userId, tx);
      const before = parsePermissions(member.permissions);

      let nextStatus: UserStatus | null = null;
      if (changes.status === 'SUSPENDED') {
        if (account.status !== UserStatus.ACTIVE) {
          throw invalidTransition(
            account.status === UserStatus.PENDING_VERIFICATION
              ? 'An invitation that has not been accepted is withdrawn by removing it, not suspended.'
              : 'This staff member is already suspended.',
          );
        }
        nextStatus = UserStatus.SUSPENDED;
      } else if (changes.status === 'ACTIVE') {
        if (account.status !== UserStatus.SUSPENDED) {
          throw invalidTransition(
            'Only a suspended staff member can be reinstated.',
          );
        }
        if (account.suspendedBy !== SuspensionSource.OPERATOR) {
          throw invalidTransition(
            'Flyviman suspended this account. Contact Flyviman support to reinstate it.',
          );
        }
        nextStatus = UserStatus.ACTIVE;
      }

      if (touchesPermissions) {
        const permissions = await this.checked(access.operatorId, {
          capabilities: changes.capabilities ?? before.capabilities,
          allAircraft: changes.allAircraft ?? before.allAircraft,
          aircraftIds: changes.aircraftIds ?? before.aircraftIds,
        });
        if (JSON.stringify(permissions) !== JSON.stringify(before)) {
          await tx.operatorMember.update({
            where: { id: member.id },
            data: { permissions: { ...permissions } },
          });
          await this.record(tx, 'operator_staff.update', member.id, {
            before,
            after: permissions,
          });
        }
      }
      if (nextStatus) {
        await this.users.changeStatus(member.userId, nextStatus, account, tx);
        if (nextStatus === UserStatus.SUSPENDED) {
          await this.auth.revokeAllSessions(member.userId, tx);
        }
        await this.record(
          tx,
          nextStatus === UserStatus.SUSPENDED
            ? 'operator_staff.suspend'
            : 'operator_staff.reinstate',
          member.id,
          {
            before: { status: account.status },
            after: { status: nextStatus },
            reason,
          },
        );
      }
      return {
        userId: member.userId,
        suspended: nextStatus === UserStatus.SUSPENDED,
      };
    });
    if (outcome.suspended) await this.revokeLinks(outcome.userId);
    return this.member(access.operatorId, memberId);
  }

  /**
   * Takes someone off the team: the membership goes, the account is
   * suspended (so an outstanding invitation link stops working) and signed
   * out everywhere. The account is kept so its audit history and uploads
   * keep their owner; inviting the address again brings it back, unless
   * Flyviman had suspended it (D-068, D-070).
   */
  async remove(
    user: AuthUser,
    memberId: string,
    reason: string,
  ): Promise<void> {
    const { access } = await this.operators.accessFor(user);
    assertAdmin(access);
    await this.staffMember(access.operatorId, memberId);
    const trimmed = reason.trim();
    if (trimmed.length < 3) {
      throw new AppException(
        'VALIDATION_ERROR',
        'Give a reason for removing this staff member.',
        HttpStatus.BAD_REQUEST,
        [{ field: 'reason', issue: 'must be at least 3 characters' }],
      );
    }
    const userId = await this.prisma.$transaction(async (tx) => {
      const member = await this.lockedMember(tx, access.operatorId, memberId);
      const account = await this.users.suspensionOf(member.userId, tx);
      await tx.operatorMember.delete({ where: { id: member.id } });
      // A Flyviman suspension is kept as it is.
      if (account.status !== UserStatus.SUSPENDED) {
        await this.users.changeStatus(
          member.userId,
          UserStatus.SUSPENDED,
          account,
          tx,
        );
      }
      await this.auth.revokeAllSessions(member.userId, tx);
      await this.record(tx, 'operator_staff.remove', member.id, {
        before: {
          userId: member.userId,
          status: account.status,
          ...parsePermissions(member.permissions),
        },
        reason: trimmed,
      });
      return member.userId;
    });
    await this.revokeLinks(userId);
  }

  /** The member row, locked for the rest of the transaction, or 404. */
  private async lockedMember(
    tx: Prisma.TransactionClient,
    operatorId: string,
    memberId: string,
  ) {
    await tx.$queryRaw`
      SELECT id FROM "OperatorMember"
      WHERE id = ${memberId}::uuid AND "operatorId" = ${operatorId}::uuid
      FOR UPDATE`;
    const member = await tx.operatorMember.findFirst({
      where: { id: memberId, operatorId },
    });
    if (!member) throw notFound();
    return member;
  }

  /** Cancels any emailed invitation or reset link the person still holds. */
  private async revokeLinks(userId: string): Promise<void> {
    await this.tokens.revokeFor(userId, 'invitation');
    await this.tokens.revokeFor(userId, 'password-reset');
  }

  // --- Helpers ------------------------------------------------------------

  /** A staff member of this operator; administrators are not managed here. */
  private async staffMember(operatorId: string, memberId: string) {
    const member = await this.prisma.operatorMember.findFirst({
      where: { id: memberId, operatorId },
    });
    if (!member) throw notFound();
    const account = (await this.users.summaries([member.userId])).get(
      member.userId,
    );
    if (!account || account.role !== Role.OPERATOR_STAFF) throw notFound();
    return { member, account };
  }

  private async member(
    operatorId: string,
    memberId: string,
  ): Promise<StaffMember> {
    const { member, account } = await this.staffMember(operatorId, memberId);
    return {
      id: member.id,
      email: account.email,
      status: staffStatus(account.status),
      suspendedBy: account.suspendedBy,
      permissions: parsePermissions(member.permissions),
      invitedAt: member.createdAt,
      lastLoginAt: account.lastLoginAt,
    };
  }

  /**
   * Validated permissions to store. Assigned aircraft must be this
   * operator's; with "all aircraft" the list is not kept.
   */
  private async checked(
    operatorId: string,
    input: PermissionsInput,
  ): Promise<StaffPermissions> {
    if (input.capabilities.length === 0) {
      throw new AppException(
        'VALIDATION_ERROR',
        'Give at least one permission.',
        HttpStatus.BAD_REQUEST,
        [{ field: 'capabilities', issue: 'must not be empty' }],
      );
    }
    if (input.allAircraft) {
      return {
        capabilities: [...input.capabilities].sort(),
        allAircraft: true,
        aircraftIds: [],
      };
    }
    if (input.aircraftIds.length === 0) {
      throw new AppException(
        'VALIDATION_ERROR',
        'Assign at least one aircraft, or all aircraft.',
        HttpStatus.BAD_REQUEST,
        [{ field: 'aircraftIds', issue: 'must not be empty' }],
      );
    }
    const unknown = await this.operators.unknownAircraft(
      operatorId,
      input.aircraftIds,
    );
    if (unknown.length > 0) {
      throw new AppException(
        'VALIDATION_ERROR',
        "Some aircraft are not this operator's.",
        HttpStatus.BAD_REQUEST,
        [{ field: 'aircraftIds', issue: 'must be aircraft of this operator' }],
      );
    }
    return {
      capabilities: [...input.capabilities].sort(),
      allAircraft: false,
      aircraftIds: [...input.aircraftIds].sort(),
    };
  }

  /** At most MAX_INVITES_PER_HOUR invitations per operator per hour. */
  private async countInvite(operatorId: string): Promise<void> {
    const hour = Math.floor(Date.now() / 3_600_000);
    const key = `operator-staff-invites:${operatorId}:${hour}`;
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, 3600);
    if (count > MAX_INVITES_PER_HOUR) {
      throw new AppException(
        'RATE_LIMITED',
        'Too many invitations in the last hour. Try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private record(
    tx: Prisma.TransactionClient,
    action: string,
    memberId: string,
    entry: { before?: object; after?: object; reason?: string },
  ): Promise<void> {
    return this.audit.record(
      {
        action,
        entityType: 'OperatorMember',
        entityId: memberId,
        before: entry.before as Prisma.InputJsonValue | undefined,
        after: entry.after as Prisma.InputJsonValue | undefined,
        reason: entry.reason,
      },
      tx,
    );
  }
}

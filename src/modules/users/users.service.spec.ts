import type { ConfigService } from '@nestjs/config';
import { Role, UserStatus } from '../../generated/prisma/enums.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import type { NotificationsService } from '../notifications/notifications.service.js';
import type { AccountTokensService } from './account-tokens.service.js';
import { UsersService } from './users.service.js';

const ADMIN = { id: 'admin-1', role: 'SUPER_ADMIN' } as unknown as AuthUser;

interface Row {
  id: string;
  role: Role;
  status: UserStatus;
  suspendedBy: string | null;
}

/**
 * A service over an in-memory user table. `otherSuperAdmins` is what the
 * count of active super administrators other than the target answers.
 */
function setup(
  target: Partial<Row> = {},
  { otherSuperAdmins = 1 }: { otherSuperAdmins?: number } = {},
) {
  const rows: Record<string, Row> = {
    'admin-1': {
      id: 'admin-1',
      role: Role.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
      suspendedBy: null,
    },
    'user-1': {
      id: 'user-1',
      role: Role.OPS,
      status: UserStatus.ACTIVE,
      suspendedBy: null,
      ...target,
    },
  };
  if (target.status === UserStatus.SUSPENDED && !('suspendedBy' in target)) {
    rows['user-1'].suspendedBy = 'PLATFORM';
  }
  const user = {
    findUnique: vi.fn(({ where }: { where: { id: string } }) =>
      Promise.resolve(rows[where.id] ?? null),
    ),
    count: vi.fn().mockResolvedValue(otherSuperAdmins),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'user-1' }),
  };
  const tx = { user, $executeRaw: vi.fn().mockResolvedValue(0) };
  const tokens = { revokeFor: vi.fn() };
  const audit = { record: vi.fn() };
  const service = new UsersService(
    {
      $transaction: (run: (db: unknown) => unknown) => run(tx),
    } as unknown as PrismaService,
    audit as unknown as AuditService,
    tokens as unknown as AccountTokensService,
    {} as NotificationsService,
    {} as ConfigService,
  );
  return { service, tx, rows, audit };
}

describe('UsersService.setStatus', () => {
  it('ends every sign-in of a suspended account, in the same transaction', async () => {
    const { service, tx } = setup();
    const revoke = vi.fn().mockResolvedValue(undefined);
    service.registerSessionRevoker(revoke);

    await service.setStatus(ADMIN, 'user-1', UserStatus.SUSPENDED, 'Fraud.');
    expect(revoke).toHaveBeenCalledWith('user-1', tx);
  });

  it('refuses to suspend when nothing can end the sessions', async () => {
    const { service } = setup();
    await expect(
      service.setStatus(ADMIN, 'user-1', UserStatus.SUSPENDED, 'Fraud.'),
    ).rejects.toThrow('No session revoker registered');
  });

  it('does not sign out a reinstated account', async () => {
    const { service } = setup({ status: UserStatus.SUSPENDED });
    const revoke = vi.fn();
    service.registerSessionRevoker(revoke);
    await service.setStatus(ADMIN, 'user-1', UserStatus.ACTIVE, 'Cleared.');
    expect(revoke).not.toHaveBeenCalled();
  });

  it('refuses to suspend the last active super administrator, under the lock', async () => {
    const { service, tx } = setup(
      { role: Role.SUPER_ADMIN },
      { otherSuperAdmins: 0 },
    );
    service.registerSessionRevoker(vi.fn());
    await expect(
      service.setStatus(ADMIN, 'user-1', UserStatus.SUSPENDED, 'Left.'),
    ).rejects.toMatchObject({ code: 'USER_LAST_SUPER_ADMIN' });
    expect(tx.$executeRaw).toHaveBeenCalled();
    expect(tx.user.updateMany).not.toHaveBeenCalled();
  });
});

describe('UsersService.changeRole', () => {
  it('changes the role conditionally, audits it with the reason and ends every sign-in', async () => {
    const { service, tx, audit } = setup();
    const revoke = vi.fn().mockResolvedValue(undefined);
    service.registerSessionRevoker(revoke);

    await service.changeRole(ADMIN, 'user-1', Role.FINANCE_ADMIN, 'Moved.');
    expect(tx.$executeRaw).toHaveBeenCalled();
    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'user-1', role: Role.OPS },
      data: { role: Role.FINANCE_ADMIN },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.role_change',
        entityId: 'user-1',
        before: { role: Role.OPS },
        after: { role: Role.FINANCE_ADMIN },
        reason: 'Moved.',
      }),
      tx,
    );
    expect(revoke).toHaveBeenCalledWith('user-1', tx);
  });

  it('refuses a change to your own role before touching the database', async () => {
    const { service, tx } = setup();
    await expect(
      service.changeRole(ADMIN, 'admin-1', Role.OPS, 'Stepping down.'),
    ).rejects.toMatchObject({ code: 'USER_INVALID_TRANSITION' });
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('refuses to demote the last active super administrator', async () => {
    const { service, tx } = setup(
      { role: Role.SUPER_ADMIN },
      { otherSuperAdmins: 0 },
    );
    service.registerSessionRevoker(vi.fn());
    await expect(
      service.changeRole(ADMIN, 'user-1', Role.OPS, 'Moved.'),
    ).rejects.toMatchObject({ code: 'USER_LAST_SUPER_ADMIN' });
    expect(tx.user.updateMany).not.toHaveBeenCalled();
  });

  it('demotes a super administrator while another stays active', async () => {
    const { service, tx } = setup({ role: Role.SUPER_ADMIN });
    service.registerSessionRevoker(vi.fn());
    await service.changeRole(ADMIN, 'user-1', Role.OPS, 'Moved.');
    expect(tx.user.count).toHaveBeenCalledWith({
      where: {
        role: Role.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
        id: { not: 'user-1' },
      },
    });
    expect(tx.user.updateMany).toHaveBeenCalled();
  });

  it('refuses a caller who stopped being an active super administrator', async () => {
    const { service, rows, tx } = setup();
    rows['admin-1'].role = Role.OPS;
    await expect(
      service.changeRole(ADMIN, 'user-1', Role.SUPER_ADMIN, 'Promote.'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(tx.user.updateMany).not.toHaveBeenCalled();
  });

  it('refuses customers and operator accounts, and an unchanged role', async () => {
    for (const role of [Role.CUSTOMER, Role.OPERATOR_ADMIN]) {
      const { service } = setup({ role });
      await expect(
        service.changeRole(ADMIN, 'user-1', Role.OPS, 'Hire.'),
      ).rejects.toMatchObject({ code: 'USER_INVALID_TRANSITION' });
    }
    const { service } = setup();
    await expect(
      service.changeRole(ADMIN, 'user-1', Role.OPS, 'Same.'),
    ).rejects.toMatchObject({ code: 'USER_INVALID_TRANSITION' });
  });

  it('refuses when the role changed at the same moment', async () => {
    const { service, tx, audit } = setup();
    service.registerSessionRevoker(vi.fn());
    tx.user.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.changeRole(ADMIN, 'user-1', Role.FINANCE_ADMIN, 'Moved.'),
    ).rejects.toMatchObject({ code: 'USER_INVALID_TRANSITION' });
    expect(audit.record).not.toHaveBeenCalled();
  });
});

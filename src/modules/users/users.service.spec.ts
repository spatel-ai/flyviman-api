import type { ConfigService } from '@nestjs/config';
import { UserStatus } from '../../generated/prisma/enums.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import type { NotificationsService } from '../notifications/notifications.service.js';
import type { AccountTokensService } from './account-tokens.service.js';
import { UsersService } from './users.service.js';

const ADMIN = { id: 'admin-1', role: 'SUPER_ADMIN' } as unknown as AuthUser;

function setup(status: UserStatus = UserStatus.ACTIVE) {
  const user = {
    findUnique: vi.fn().mockResolvedValue({
      id: 'user-1',
      status,
      suspendedBy: status === UserStatus.SUSPENDED ? 'PLATFORM' : null,
    }),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'user-1' }),
  };
  const tx = { user };
  const tokens = { revokeFor: vi.fn() };
  const service = new UsersService(
    {
      $transaction: (run: (db: unknown) => unknown) => run(tx),
    } as unknown as PrismaService,
    { record: vi.fn() } as unknown as AuditService,
    tokens as unknown as AccountTokensService,
    {} as NotificationsService,
    {} as ConfigService,
  );
  return { service, tx };
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
    const { service } = setup(UserStatus.SUSPENDED);
    const revoke = vi.fn();
    service.registerSessionRevoker(revoke);
    await service.setStatus(ADMIN, 'user-1', UserStatus.ACTIVE, 'Cleared.');
    expect(revoke).not.toHaveBeenCalled();
  });
});

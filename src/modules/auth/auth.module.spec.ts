import type { UsersService } from '../users/users.service.js';
import { AuthModule } from './auth.module.js';
import type { AuthService } from './auth.service.js';

describe('AuthModule session revoker', () => {
  it('lets the users module end every sign-in, in its transaction', async () => {
    const auth = { revokeAllSessions: vi.fn().mockResolvedValue(undefined) };
    const users = { registerSessionRevoker: vi.fn() };
    new AuthModule(
      auth as unknown as AuthService,
      users as unknown as UsersService,
    ).onModuleInit();
    const [revoke] = users.registerSessionRevoker.mock.calls[0] as [
      (userId: string, db: unknown) => Promise<void>,
    ];
    const tx = {};
    await revoke('user-1', tx);
    expect(auth.revokeAllSessions).toHaveBeenCalledWith('user-1', tx);
  });
});

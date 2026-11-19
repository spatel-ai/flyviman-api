import { RateLimitGuard } from '../../common/rate-limit/rate-limit.js';
import type { UsersService } from '../users/users.service.js';
import { AuthModule } from './auth.module.js';
import type { AuthService } from './auth.service.js';
import type { TokenService } from './token.service.js';

function setup() {
  const tokens = {
    hashToken: (token: string) => `hash:${token}`,
    verifyAccessToken: vi.fn().mockResolvedValue(null),
  };
  const auth = {
    isRefreshKnown: vi.fn(),
    isRefreshInPlay: vi.fn(),
    revokeAllSessions: vi.fn().mockResolvedValue(undefined),
  };
  const users = { registerSessionRevoker: vi.fn() };
  new AuthModule(
    tokens as unknown as TokenService,
    auth as unknown as AuthService,
    users as unknown as UsersService,
  ).onModuleInit();
  return { auth, users };
}

const refresh = (token?: string) => ({
  path: '/api/v1/auth/refresh',
  cookies: token ? { refresh_token: token } : {},
});

describe('AuthModule rate-limit identity for refreshes', () => {
  const identify = RateLimitGuard.identify;
  const exempt = RateLimitGuard.exempt;
  afterEach(() => {
    RateLimitGuard.identify = identify;
    RateLimitGuard.exempt = exempt;
  });

  it('counts a token that belongs to a session against that token', async () => {
    const { auth } = setup();
    auth.isRefreshKnown.mockResolvedValue(true);
    await expect(RateLimitGuard.identify(refresh('real'))).resolves.toBe(
      'refresh:hash:real',
    );
  });

  it('counts a made-up token by address', async () => {
    const { auth } = setup();
    auth.isRefreshKnown.mockResolvedValue(false);
    await expect(RateLimitGuard.identify(refresh('made-up'))).resolves.toBe(
      null,
    );
  });

  it('counts by address when the lookup fails', async () => {
    const { auth } = setup();
    auth.isRefreshKnown.mockRejectedValue(new Error('database down'));
    await expect(RateLimitGuard.identify(refresh('any'))).resolves.toBe(null);
  });

  it('counts a refresh with no cookie by address', async () => {
    setup();
    await expect(RateLimitGuard.identify(refresh())).resolves.toBe(null);
  });
});

describe('AuthModule session revoker', () => {
  it('lets the users module end every sign-in, in its transaction', async () => {
    const { auth, users } = setup();
    const [revoke] = users.registerSessionRevoker.mock.calls[0] as [
      (userId: string, db: unknown) => Promise<void>,
    ];
    const tx = {};
    await revoke('user-1', tx);
    expect(auth.revokeAllSessions).toHaveBeenCalledWith('user-1', tx);
  });
});

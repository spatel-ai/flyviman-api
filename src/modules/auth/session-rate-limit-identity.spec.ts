import type { AuthService } from './auth.service.js';
import { SessionRateLimitIdentity } from './session-rate-limit-identity.js';
import type { TokenService } from './token.service.js';

function setup() {
  const tokens = {
    hashToken: (token: string) => `hash:${token}`,
    verifyAccessToken: vi.fn().mockResolvedValue(null),
  };
  const auth = { refreshTokenState: vi.fn() };
  const identity = new SessionRateLimitIdentity(
    tokens as unknown as TokenService,
    auth as unknown as AuthService,
  );
  return { identity, tokens, auth };
}

const refresh = (token?: string) => ({
  path: '/api/v1/auth/refresh',
  cookies: token ? { refresh_token: token } : {},
});

describe('SessionRateLimitIdentity for refreshes', () => {
  it('counts a token that belongs to a session against that token', async () => {
    const { identity, auth } = setup();
    auth.refreshTokenState.mockResolvedValue({ known: true, inPlay: false });
    await expect(identity.identify(refresh('real'))).resolves.toBe(
      'refresh:hash:real',
    );
  });

  it('counts a made-up token by address', async () => {
    const { identity, auth } = setup();
    auth.refreshTokenState.mockResolvedValue({ known: false, inPlay: false });
    await expect(identity.identify(refresh('made-up'))).resolves.toBe(null);
  });

  it('counts by address when the lookup fails', async () => {
    const { identity, auth } = setup();
    auth.refreshTokenState.mockRejectedValue(new Error('database down'));
    await expect(identity.identify(refresh('any'))).resolves.toBe(null);
  });

  it('counts a refresh with no cookie by address', async () => {
    const { identity } = setup();
    await expect(identity.identify(refresh())).resolves.toBe(null);
  });

  it('exempts a racing refresh of a token in play, and nothing else', async () => {
    const { identity, auth } = setup();
    auth.refreshTokenState.mockResolvedValue({ known: true, inPlay: true });
    await expect(identity.exempt(refresh('real'))).resolves.toBe(true);
    await expect(identity.exempt(refresh())).resolves.toBe(false);
    await expect(identity.exempt({ path: '/api/v1/me' })).resolves.toBe(false);
    auth.refreshTokenState.mockRejectedValue(new Error('redis down'));
    await expect(identity.exempt(refresh('real'))).resolves.toBe(false);
  });

  it('looks the session up once per request for exempt and identify', async () => {
    const { identity, auth } = setup();
    auth.refreshTokenState.mockResolvedValue({ known: true, inPlay: false });
    const request = refresh('retired');
    await expect(identity.exempt(request)).resolves.toBe(false);
    await expect(identity.identify(request)).resolves.toBe(
      'refresh:hash:retired',
    );
    await expect(identity.identify(request)).resolves.toBe(
      'refresh:hash:retired',
    );
    expect(auth.refreshTokenState).toHaveBeenCalledTimes(1);
    // A different request looks again.
    await identity.identify(refresh('retired'));
    expect(auth.refreshTokenState).toHaveBeenCalledTimes(2);
  });
});

describe('SessionRateLimitIdentity for other requests', () => {
  it('counts a verified access token against its user', async () => {
    const { identity, tokens } = setup();
    tokens.verifyAccessToken.mockResolvedValue({ sub: 'user-1' });
    await expect(
      identity.identify({
        path: '/api/v1/me',
        cookies: { access_token: 'signed' },
      }),
    ).resolves.toBe('user:user-1');
  });

  it('counts sign-in and an unverified token by address', async () => {
    const { identity, tokens } = setup();
    tokens.verifyAccessToken.mockResolvedValue({ sub: 'user-1' });
    await expect(
      identity.identify({
        path: '/api/v1/auth/login',
        cookies: { access_token: 'signed' },
      }),
    ).resolves.toBe(null);
    tokens.verifyAccessToken.mockResolvedValue(null);
    await expect(
      identity.identify({
        path: '/api/v1/me',
        cookies: { access_token: 'forged' },
      }),
    ).resolves.toBe(null);
  });
});

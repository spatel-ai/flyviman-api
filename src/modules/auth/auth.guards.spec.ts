import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Role, UserStatus } from '../../generated/prisma/enums.js';
import type { UsersService } from '../users/users.service.js';
import { IS_PUBLIC, ROLES, SKIP_CSRF } from './auth.decorators.js';
import { CsrfGuard, JwtAuthGuard, RolesGuard } from './auth.guards.js';
import type { AuthService } from './auth.service.js';
import type { TokenService } from './token.service.js';

function context(request: object): ExecutionContext {
  return {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function reflector(metadata: Record<string, unknown>): Reflector {
  return {
    getAllAndOverride: (key: string) => metadata[key],
  } as unknown as Reflector;
}

describe('JwtAuthGuard', () => {
  // A signed-in request whose access token is still valid.
  function guard(status: UserStatus, sessionLive: boolean) {
    const tokens = {
      verifyAccessToken: () => Promise.resolve({ sub: 'u1', sid: 'family-1' }),
    } as unknown as TokenService;
    const users = {
      findAccount: () =>
        Promise.resolve({
          id: 'u1',
          email: null,
          phone: null,
          role: Role.CUSTOMER,
          status,
        }),
    } as unknown as UsersService;
    const auth = {
      isFamilyActive: () => Promise.resolve(sessionLive),
    } as unknown as AuthService;
    return new JwtAuthGuard(reflector({}), tokens, users, auth);
  }
  const request = { cookies: { access_token: 'still-valid' } };

  it('lets an active account with a live session through', async () => {
    await expect(
      guard(UserStatus.ACTIVE, true).canActivate(context({ ...request })),
    ).resolves.toBe(true);
  });

  it('refuses an erased account at once, whatever its token (W5-8b)', async () => {
    await expect(
      guard(UserStatus.ERASED, true).canActivate(context({ ...request })),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('refuses a token whose sessions were deleted, as an erasure does', async () => {
    await expect(
      guard(UserStatus.ACTIVE, false).canActivate(context({ ...request })),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});

describe('RolesGuard', () => {
  const admin = { user: { id: 'u1', role: Role.SUPER_ADMIN } };
  const customer = { user: { id: 'u2', role: Role.CUSTOMER } };

  it('lets a listed role through', () => {
    const guard = new RolesGuard(reflector({ [ROLES]: [Role.SUPER_ADMIN] }));
    expect(guard.canActivate(context(admin))).toBe(true);
  });

  it('refuses a role that is not listed', () => {
    const guard = new RolesGuard(reflector({ [ROLES]: [Role.SUPER_ADMIN] }));
    expect(() => guard.canActivate(context(customer))).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
  });

  it('refuses a private route that declares no roles', () => {
    const guard = new RolesGuard(reflector({}));
    expect(() => guard.canActivate(context(admin))).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
  });

  it('does not apply to public routes', () => {
    const guard = new RolesGuard(reflector({ [IS_PUBLIC]: true }));
    expect(guard.canActivate(context({}))).toBe(true);
  });
});

describe('CsrfGuard', () => {
  const config = {
    getOrThrow: () => 'https://www.flyviman.test',
  } as unknown as ConfigService;

  function request(
    method: string,
    cookies: Record<string, string>,
    csrf?: string,
    headers: Record<string, string> = {},
  ) {
    return {
      method,
      cookies,
      header: (name: string) =>
        name === 'x-csrf-token' ? csrf : headers[name],
    };
  }
  const session = { access_token: 'a', csrf_token: 'token-value' };

  it('ignores requests that do not change state', () => {
    const guard = new CsrfGuard(reflector({}), config);
    expect(guard.canActivate(context(request('GET', session)))).toBe(true);
  });

  it('ignores requests that carry no session', () => {
    const guard = new CsrfGuard(reflector({}), config);
    expect(guard.canActivate(context(request('POST', {})))).toBe(true);
  });

  it('accepts a header that matches the cookie', () => {
    const guard = new CsrfGuard(reflector({}), config);
    expect(
      guard.canActivate(context(request('POST', session, 'token-value'))),
    ).toBe(true);
  });

  it.each([undefined, '', 'other-value', 'token-valuX'])(
    'refuses header %j',
    (header) => {
      const guard = new CsrfGuard(reflector({}), config);
      expect(() =>
        guard.canActivate(context(request('DELETE', session, header))),
      ).toThrow(expect.objectContaining({ code: 'CSRF_TOKEN_INVALID' }));
    },
  );

  it('refuses when only the refresh cookie is present and no token is sent', () => {
    const guard = new CsrfGuard(reflector({}), config);
    expect(() =>
      guard.canActivate(context(request('POST', { refresh_token: 'r' }))),
    ).toThrow(expect.objectContaining({ code: 'CSRF_TOKEN_INVALID' }));
  });

  it('refuses a request a browser says came from another site, even with no session', () => {
    const guard = new CsrfGuard(reflector({}), config);
    const crossSite: Record<string, string>[] = [
      { origin: 'https://evil.example' },
      { origin: 'null' },
      { 'sec-fetch-site': 'cross-site' },
    ];
    for (const headers of crossSite) {
      expect(() =>
        guard.canActivate(context(request('POST', {}, undefined, headers))),
      ).toThrow(expect.objectContaining({ code: 'CSRF_ORIGIN_REFUSED' }));
    }
  });

  it('accepts a request from the web origin', () => {
    const guard = new CsrfGuard(reflector({}), config);
    expect(
      guard.canActivate(
        context(
          request('POST', session, 'token-value', {
            origin: 'https://www.flyviman.test',
            'sec-fetch-site': 'same-site',
          }),
        ),
      ),
    ).toBe(true);
  });

  it('skips routes marked @SkipCsrf()', () => {
    const guard = new CsrfGuard(reflector({ [SKIP_CSRF]: true }), config);
    expect(guard.canActivate(context(request('POST', session)))).toBe(true);
  });
});

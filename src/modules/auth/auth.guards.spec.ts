import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Role } from '../../generated/prisma/enums.js';
import { IS_PUBLIC, ROLES, SKIP_CSRF } from './auth.decorators.js';
import { CsrfGuard, RolesGuard } from './auth.guards.js';

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
      ).toThrow(expect.objectContaining({ code: 'CSRF_TOKEN_INVALID' }));
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

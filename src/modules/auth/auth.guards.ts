import { timingSafeEqual } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { requestContext } from '../../common/context/request-context.js';
import { AppException } from '../../common/errors/app.exception.js';
import { Role, UserStatus } from '../../generated/prisma/enums.js';
import { UsersService } from '../users/users.service.js';
import {
  ACCESS_COOKIE,
  CSRF_COOKIE,
  CSRF_HEADER,
  REFRESH_COOKIE,
} from './auth.cookies.js';
import { IS_PUBLIC, ROLES, SKIP_CSRF } from './auth.decorators.js';
import { AuthService } from './auth.service.js';
import { TokenService } from './token.service.js';

type Cookies = Record<string, string | undefined>;

function cookies(request: Request): Cookies {
  return (request.cookies ?? {}) as Cookies;
}

function isPublic(reflector: Reflector, context: ExecutionContext): boolean {
  return (
    reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]) === true
  );
}

/**
 * Every route needs a signed-in, active user unless it is marked `@Public()`.
 * The user's role and status are read on each request, so a suspension or a
 * role change takes effect at once, not when the access token expires.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly users: UsersService,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (isPublic(this.reflector, context)) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const token = cookies(request)[ACCESS_COOKIE];
    const claims = token ? await this.tokens.verifyAccessToken(token) : null;
    const account = claims ? await this.users.findAccount(claims.sub) : null;

    if (
      !claims ||
      !account ||
      account.status !== UserStatus.ACTIVE ||
      !(await this.auth.isFamilyActive(claims.sid))
    ) {
      throw new AppException(
        'UNAUTHENTICATED',
        'Sign in to continue.',
        HttpStatus.UNAUTHORIZED,
      );
    }

    request.user = {
      id: account.id,
      role: account.role,
      sessionFamilyId: claims.sid,
    };
    const store = requestContext.get();
    if (store) store.actor = { id: account.id, role: account.role };
    return true;
  }
}

/**
 * Checks `@Roles()`. A private route that declares no roles is refused, so a
 * forgotten decorator fails closed.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (isPublic(this.reflector, context)) return true;

    const allowed = this.reflector.getAllAndOverride<Role[] | undefined>(
      ROLES,
      [context.getHandler(), context.getClass()],
    );
    const user = context.switchToHttp().getRequest<Request>().user;
    if (!user || !allowed?.includes(user.role)) {
      throw new AppException(
        'FORBIDDEN',
        'You do not have access to this.',
        HttpStatus.FORBIDDEN,
      );
    }
    return true;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Cross-site request forgery protection for state-changing requests, in two
 * layers:
 *
 * 1. A request a browser says came from another site (`Origin` or
 *    `Sec-Fetch-Site`) is refused, session or not. This also stops a page
 *    on another site from signing a visitor in to an attacker's account.
 * 2. A request that carries a session cookie must repeat the readable CSRF
 *    cookie in `X-CSRF-Token`, which a page on another site cannot do.
 *
 * Requests with neither header come from non-browser clients (the web
 * server, provider webhooks, tests) and are subject to the second check only.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  private readonly webOrigin: string;

  constructor(
    private readonly reflector: Reflector,
    config: ConfigService,
  ) {
    this.webOrigin = config.getOrThrow<string>('WEB_ORIGIN');
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(request.method)) return true;

    const skip = this.reflector.getAllAndOverride<boolean | undefined>(
      SKIP_CSRF,
      [context.getHandler(), context.getClass()],
    );
    if (skip) return true;

    const origin = request.header('origin');
    const site = request.header('sec-fetch-site');
    if (
      (origin !== undefined && origin !== this.webOrigin) ||
      site === 'cross-site'
    ) {
      throw this.refused();
    }

    const jar = cookies(request);
    const hasSession = Boolean(jar[ACCESS_COOKIE] ?? jar[REFRESH_COOKIE]);
    if (!hasSession) return true;

    const cookie = jar[CSRF_COOKIE] ?? '';
    const header = request.header(CSRF_HEADER) ?? '';
    const a = Buffer.from(cookie);
    const b = Buffer.from(header);
    if (a.length === 0 || a.length !== b.length || !timingSafeEqual(a, b)) {
      throw this.refused();
    }
    return true;
  }

  private refused(): AppException {
    return new AppException(
      'CSRF_TOKEN_INVALID',
      'This request could not be verified. Refresh the page and try again.',
      HttpStatus.FORBIDDEN,
    );
  }
}

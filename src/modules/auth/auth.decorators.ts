import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import type { Request } from 'express';
import { Role } from '../../generated/prisma/enums.js';
import type { AuthUser } from './auth-user.js';

export const IS_PUBLIC = 'isPublic';
export const ROLES = 'roles';
export const SKIP_CSRF = 'skipCsrf';

/** Opens a route to callers who are not signed in. Routes are private by default. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Restricts a route to the listed roles. A private route without this is refused. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

/** For routes the catalogue marks AUTH: any signed-in user, whatever the role. */
export const AnyRole = () => SetMetadata(ROLES, Object.values(Role));

/**
 * Exempts a route from the CSRF check. Only for requests that do not come
 * from a browser session, such as provider webhooks, which are verified by
 * signature instead.
 */
export const SkipCsrf = () => SetMetadata(SKIP_CSRF, true);

/** The signed-in caller. Only valid on routes that are not `@Public()`. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthUser => {
    const user = context.switchToHttp().getRequest<Request>().user;
    if (!user) {
      throw new Error(
        '@CurrentUser() used on a route without a signed-in user',
      );
    }
    return user;
  },
);

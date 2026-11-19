import {
  applyDecorators,
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
export const OPTIONAL_USER = 'optionalUser';

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

/**
 * A public route that also recognises a signed-in caller, for answers that
 * differ only for them (whether a customer follows an empty leg). An
 * invalid or missing session is treated as anonymous, never refused. Read
 * the caller with `@OptionalUser()`. The response is kept out of shared
 * caches when a caller is recognised (NoStoreInterceptor).
 */
export const PublicOptionalUser = () =>
  applyDecorators(Public(), SetMetadata(OPTIONAL_USER, true));

/** The signed-in caller on a `@PublicOptionalUser()` route, or null. */
export const OptionalUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthUser | null =>
    context.switchToHttp().getRequest<Request>().user ?? null,
);

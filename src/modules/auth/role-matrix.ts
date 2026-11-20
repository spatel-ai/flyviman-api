import { RequestMethod } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { Role } from '../../generated/prisma/enums.js';
import { IS_PUBLIC, ROLES } from './auth.decorators.js';

// Nest's own metadata keys (@nestjs/common constants, @nestjs/swagger).
const PATH_METADATA = 'path';
const METHOD_METADATA = 'method';
const API_OPERATION = 'swagger/apiOperation';

/** Who may call one route, read from the same metadata `RolesGuard` reads. */
export interface RouteAccess {
  method: string;
  /** Without the global prefix, for example `/admin/users/:id/role`. */
  path: string;
  summary: string | null;
  /** True for `@Public()` routes, open to anyone. */
  public: boolean;
  /** The roles `RolesGuard` lets through; empty for a public route. */
  roles: Role[];
}

/** What each role is for (security-rbac.md). */
export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  CUSTOMER:
    'Searches, books and pays for flights; manages their own profile, passengers and trips.',
  OPERATOR_ADMIN:
    "Runs an operator's account: company profile, documents, staff, fleet, availability, pricing inputs and booking requests.",
  OPERATOR_STAFF:
    "Works on the operator's aircraft they are assigned, within the capabilities their administrator gives them.",
  OPS: 'Flyviman operations: operator and aircraft review, documents, content, enquiries, booking requests and air ambulance missions.',
  FINANCE_ADMIN:
    'Flyviman finance: commission, markup, fees, tax, promotions, payments, refunds, settlements and operator rates.',
  SUPER_ADMIN:
    'Everything internal, including internal accounts and their roles.',
};

export const INTERNAL_ROLES: Role[] = [
  Role.OPS,
  Role.FINANCE_ADMIN,
  Role.SUPER_ADMIN,
];

const ROLE_ORDER = Object.values(Role);

function paths(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string');
  return typeof value === 'string' ? [value] : [''];
}

function join(...parts: string[]): string {
  const joined = parts
    .flatMap((part) => part.split('/'))
    .filter((segment) => segment !== '')
    .join('/');
  return `/${joined}`;
}

/**
 * Every route of the given controllers with who may call it, resolved the
 * way the guards resolve it (`getAllAndOverride` on handler, then class), so
 * the table can never disagree with what is enforced. Sorted by path, then
 * method.
 */
export function routeAccess(
  reflector: Reflector,
  controllers: { metatype: object; methodNames: string[] }[],
): RouteAccess[] {
  const routes: RouteAccess[] = [];
  for (const { metatype, methodNames } of controllers) {
    const prototype = (metatype as { prototype: Record<string, unknown> })
      .prototype;
    const base = paths(Reflect.getMetadata(PATH_METADATA, metatype));
    for (const name of methodNames) {
      const handler = prototype[name];
      if (typeof handler !== 'function') continue;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as
        RequestMethod | undefined;
      const own = Reflect.getMetadata(PATH_METADATA, handler) as unknown;
      if (method === undefined || own === undefined) continue;

      const targets = [handler as () => unknown, metatype as () => unknown];
      const isPublic =
        reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, targets) ===
        true;
      const allowed =
        reflector.getAllAndOverride<Role[] | undefined>(ROLES, targets) ?? [];
      const operation = Reflect.getMetadata(API_OPERATION, handler) as
        { summary?: string } | undefined;
      for (const prefix of base) {
        for (const path of paths(own)) {
          routes.push({
            method: RequestMethod[method],
            path: join(prefix, path),
            summary: operation?.summary ?? null,
            public: isPublic,
            roles: isPublic
              ? []
              : ROLE_ORDER.filter((role) => allowed.includes(role)),
          });
        }
      }
    }
  }
  return routes.sort(
    (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
  );
}

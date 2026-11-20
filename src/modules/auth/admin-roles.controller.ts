import { Controller, Get } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Role } from '../../generated/prisma/enums.js';
import {
  CAPABILITIES,
  CAPABILITY_DESCRIPTIONS,
} from '../operators/operator-access.js';
import { Roles } from './auth.decorators.js';
import { RoleMatrixResponseDto } from './dto/role-matrix.dto.js';
import {
  INTERNAL_ROLES,
  ROLE_DESCRIPTIONS,
  routeAccess,
} from './role-matrix.js';

/**
 * The role matrix as enforced: generated from the `@Roles()` and
 * `@Public()` metadata on every controller, so it cannot drift from the
 * guards. Read-only; roles are assigned per account at
 * `PATCH /admin/users/:id/role`.
 */
@ApiTags('admin: users')
@ApiCookieAuth()
@Controller('admin/roles')
export class AdminRolesController {
  private matrix: RoleMatrixResponseDto | null = null;

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  @Get()
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Roles, the routes each may call, and staff capabilities',
    description:
      'Generated from the route metadata the role guard enforces. Route-level only: services narrow further by record and field.',
  })
  @ApiOkResponse({ type: RoleMatrixResponseDto })
  get(): RoleMatrixResponseDto {
    // Routes are fixed once the application has started.
    this.matrix ??= {
      roles: Object.values(Role).map((role) => ({
        role,
        internal: INTERNAL_ROLES.includes(role),
        description: ROLE_DESCRIPTIONS[role],
      })),
      routes: routeAccess(
        this.reflector,
        this.discovery.getControllers().flatMap((wrapper) =>
          wrapper.metatype
            ? [
                {
                  metatype: wrapper.metatype,
                  methodNames: this.scanner.getAllMethodNames(
                    wrapper.metatype.prototype as object,
                  ),
                },
              ]
            : [],
        ),
      ),
      capabilities: CAPABILITIES.map((capability) => ({
        capability,
        description: CAPABILITY_DESCRIPTIONS[capability],
      })),
    };
    return this.matrix;
  }
}

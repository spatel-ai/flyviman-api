import { Controller, Get, Patch } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiOperation } from '@nestjs/swagger';
import { Role } from '../../generated/prisma/enums.js';
import { AnyRole, Public, Roles } from './auth.decorators.js';
import { routeAccess } from './role-matrix.js';

@Roles(Role.OPS, Role.SUPER_ADMIN)
@Controller('admin/things')
class ThingsController {
  @Get()
  @ApiOperation({ summary: 'List things' })
  list(): void {}

  @Patch(':id')
  @Roles(Role.SUPER_ADMIN)
  change(): void {}

  @Get('open')
  @Public()
  open(): void {}

  @Get('mine')
  @AnyRole()
  mine(): void {}

  helper(): void {}
}

@Controller('bare')
class BareController {
  @Get()
  refused(): void {}
}

const controllers = [ThingsController, BareController].map((metatype) => ({
  metatype,
  methodNames: Object.getOwnPropertyNames(metatype.prototype).filter(
    (name) => name !== 'constructor',
  ),
}));

describe('routeAccess', () => {
  const routes = routeAccess(new Reflector(), controllers);

  it('resolves roles as the guard does: the handler overrides the class', () => {
    expect(routes).toEqual([
      {
        method: 'GET',
        path: '/admin/things',
        summary: 'List things',
        public: false,
        roles: [Role.OPS, Role.SUPER_ADMIN],
      },
      {
        method: 'PATCH',
        path: '/admin/things/:id',
        summary: null,
        public: false,
        roles: [Role.SUPER_ADMIN],
      },
      {
        method: 'GET',
        path: '/admin/things/mine',
        summary: null,
        public: false,
        roles: Object.values(Role),
      },
      {
        method: 'GET',
        path: '/admin/things/open',
        summary: null,
        public: true,
        roles: [],
      },
      // A private route without roles is refused to everyone.
      {
        method: 'GET',
        path: '/bare',
        summary: null,
        public: false,
        roles: [],
      },
    ]);
  });

  it('skips methods that are not routes', () => {
    expect(routes.some((route) => route.path.includes('helper'))).toBe(false);
  });
});

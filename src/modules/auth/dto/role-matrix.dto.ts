import { ApiProperty } from '@nestjs/swagger';
import { Role } from '../../../generated/prisma/enums.js';
import {
  CAPABILITIES,
  type Capability,
} from '../../operators/operator-access.js';

export class RoleDefinitionDto {
  @ApiProperty({ enum: Role, enumName: 'Role' })
  role!: Role;

  @ApiProperty({ description: 'A Flyviman staff role (admin portal).' })
  internal!: boolean;

  @ApiProperty()
  description!: string;
}

export class RouteAccessDto {
  @ApiProperty({ example: 'PATCH' })
  method!: string;

  @ApiProperty({
    example: '/admin/users/:id/role',
    description: 'Without the `/api/v1` prefix.',
  })
  path!: string;

  @ApiProperty({ type: String, nullable: true })
  summary!: string | null;

  @ApiProperty({ description: 'Open to anyone, signed in or not.' })
  public!: boolean;

  @ApiProperty({
    enum: Role,
    enumName: 'Role',
    isArray: true,
    description:
      'The roles the role check lets through; empty for a public route. Services may narrow further by record or field (ownership, staff capabilities, finance-only figures).',
  })
  roles!: Role[];
}

export class CapabilityDefinitionDto {
  @ApiProperty({ enum: CAPABILITIES, enumName: 'StaffCapability' })
  capability!: Capability;

  @ApiProperty()
  description!: string;
}

export class RoleMatrixResponseDto {
  @ApiProperty({ type: [RoleDefinitionDto] })
  roles!: RoleDefinitionDto[];

  @ApiProperty({
    type: [RouteAccessDto],
    description:
      'Every route with the roles allowed, read from the same metadata the role guard enforces. Sorted by path, then method.',
  })
  routes!: RouteAccessDto[];

  @ApiProperty({
    type: [CapabilityDefinitionDto],
    description:
      'Operator staff capabilities, which operator administrators give their staff. Administrators hold them all.',
  })
  capabilities!: CapabilityDefinitionDto[];
}

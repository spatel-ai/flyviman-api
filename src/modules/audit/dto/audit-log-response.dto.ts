import { ApiProperty } from '@nestjs/swagger';
import { Role } from '../../../generated/prisma/enums.js';

export class AuditLogResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  actorId: string | null;

  @ApiProperty({ enum: Role, enumName: 'Role', nullable: true })
  actorRole: Role | null;

  @ApiProperty({ example: 'auth.login' })
  action: string;

  @ApiProperty({ example: 'User' })
  entityType: string;

  @ApiProperty()
  entityId: string;

  @ApiProperty({ type: Object, nullable: true })
  before: unknown;

  @ApiProperty({ type: Object, nullable: true })
  after: unknown;

  @ApiProperty({ type: String, nullable: true })
  reason: string | null;

  @ApiProperty({
    description:
      'True when this role was shown less than the record holds: before, after or reason withheld, or passenger or medical fields in them set to null.',
  })
  restricted: boolean;

  @ApiProperty({ type: String, nullable: true })
  ipAddress: string | null;

  @ApiProperty({ type: String, nullable: true })
  requestId: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;
}

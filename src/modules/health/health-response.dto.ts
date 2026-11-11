import { ApiProperty } from '@nestjs/swagger';
import type { DependencyStatus } from './health.service.js';

export class HealthChecksDto {
  @ApiProperty({ enum: ['up', 'down'] })
  database: DependencyStatus;
}

export class HealthResponseDto {
  @ApiProperty({ example: 'ok' })
  status: 'ok';

  @ApiProperty({ example: 42 })
  uptimeSeconds: number;

  @ApiProperty({ type: HealthChecksDto })
  checks: HealthChecksDto;
}

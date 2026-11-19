import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsObject, ValidateIf, ValidateNested } from 'class-validator';
import { AircraftRestrictionsDto } from '../../../common/restrictions/restrictions.dto.js';

/**
 * Operator-wide restrictions, in the shape of an aircraft's (D-104).
 * Matching applies both; the stricter wins.
 */
export class SetOperatorRestrictionsDto {
  @ApiProperty({
    type: AircraftRestrictionsDto,
    nullable: true,
    description:
      'Replaces the whole object; `null` clears it. Required: leaving it out is refused.',
  })
  @ValidateIf(
    (object: SetOperatorRestrictionsDto) => object.restrictions !== null,
  )
  @IsObject()
  @ValidateNested()
  @Type(() => AircraftRestrictionsDto)
  restrictions: AircraftRestrictionsDto | null;
}

export class OperatorRestrictionsResponseDto {
  @ApiProperty({ type: AircraftRestrictionsDto, nullable: true })
  restrictions: AircraftRestrictionsDto | null;
}

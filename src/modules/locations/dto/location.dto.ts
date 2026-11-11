import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PageQueryDto } from '../../../common/dto/page-query.dto.js';
import { LocationType } from '../../../generated/prisma/enums.js';

export class ListLocationsDto extends PageQueryDto {
  @ApiPropertyOptional({
    description:
      'Part of a name or city, or an IATA or ICAO code. Exact codes rank first.',
    example: 'mumbai',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ enum: LocationType, enumName: 'LocationType' })
  @IsOptional()
  @IsEnum(LocationType)
  type?: LocationType;
}

export class LocationCapabilitiesDto {
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Longest usable runway in metres; null for heliports and where unknown.',
  })
  runwayLengthM: number | null;

  @ApiProperty({
    type: Boolean,
    nullable: true,
    description: 'Null where unknown.',
  })
  nightOperations: boolean | null;

  @ApiProperty()
  helicopterApproved: boolean;
}

/** What anyone may see. Charges are pricing inputs and stay internal. */
export class LocationResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: LocationType, enumName: 'LocationType' })
  type: LocationType;

  @ApiProperty({ example: 'Chhatrapati Shivaji Maharaj International Airport' })
  name: string;

  @ApiProperty({ type: String, nullable: true, example: 'BOM' })
  iata: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'VABB' })
  icao: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'Mumbai' })
  city: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'Maharashtra' })
  state: string | null;

  @ApiProperty({ description: 'ISO 3166-1 alpha-2.', example: 'IN' })
  country: string;

  @ApiProperty()
  latitude: number;

  @ApiProperty()
  longitude: number;

  @ApiProperty({ description: 'IANA time zone.', example: 'Asia/Kolkata' })
  timeZone: string;

  @ApiProperty({ type: LocationCapabilitiesDto })
  capabilities: LocationCapabilitiesDto;
}

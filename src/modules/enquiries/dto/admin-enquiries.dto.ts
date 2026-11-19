import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional } from 'class-validator';
import { PageQueryDto } from '../../../common/dto/page-query.dto.js';
import { EnquiryTopic } from '../../../generated/prisma/enums.js';

export class ListEnquiriesDto extends PageQueryDto {
  @ApiPropertyOptional({
    type: Boolean,
    description:
      '`true` for handled enquiries only, `false` for unhandled only.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  handled?: boolean;

  @ApiPropertyOptional({ enum: EnquiryTopic, enumName: 'EnquiryTopic' })
  @IsOptional()
  @IsEnum(EnquiryTopic)
  topic?: EnquiryTopic;
}

/** An enquiry as operations see it. Personal data: never logged. */
export class AdminEnquiryResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'FLY-ENQ-7K2M9Q' })
  reference: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ nullable: true, type: String })
  email: string | null;

  @ApiProperty({ nullable: true, type: String })
  phone: string | null;

  @ApiProperty({ enum: EnquiryTopic, enumName: 'EnquiryTopic' })
  topic: EnquiryTopic;

  @ApiProperty()
  message: string;

  @ApiProperty({
    format: 'date-time',
    nullable: true,
    type: String,
    description: 'When operations marked it handled; null while unhandled.',
  })
  handledAt: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;
}

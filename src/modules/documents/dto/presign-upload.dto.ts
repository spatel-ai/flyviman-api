import { ApiProperty } from '@nestjs/swagger';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { FilePurpose } from '../../../generated/prisma/enums.js';
import { ALLOWED_CONTENT_TYPES } from '../../../integrations/storage/file-signature.js';
import { MAX_UPLOAD_BYTES } from '../documents.service.js';

export class PresignUploadDto {
  @ApiProperty({ enum: FilePurpose, enumName: 'FilePurpose' })
  @IsEnum(FilePurpose)
  purpose: FilePurpose;

  @ApiProperty({ example: 'air-operator-certificate.pdf' })
  @IsString()
  @MaxLength(200)
  @Matches(/^[^\\/\p{Cc}]+$/u, {
    message: 'fileName must be a file name, not a path',
  })
  fileName: string;

  @ApiProperty({ enum: ALLOWED_CONTENT_TYPES })
  @IsIn(ALLOWED_CONTENT_TYPES)
  contentType: string;

  @ApiProperty({ minimum: 1, maximum: MAX_UPLOAD_BYTES })
  @IsInt()
  @Min(1)
  @Max(MAX_UPLOAD_BYTES)
  sizeBytes: number;
}

export class UploadTargetDto {
  @ApiProperty()
  url: string;

  @ApiProperty({ enum: ['PUT'] })
  method: string;

  @ApiProperty({
    type: Object,
    description: 'Headers to send with the upload.',
    example: { 'Content-Type': 'application/pdf' },
  })
  headers: Record<string, string>;

  @ApiProperty({ format: 'date-time' })
  expiresAt: string;
}

export class PresignUploadResponseDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Pass this when attaching the file to a record.',
  })
  fileId: string;

  @ApiProperty({ type: UploadTargetDto })
  upload: UploadTargetDto;
}

export class DownloadLinkResponseDto {
  @ApiProperty()
  url: string;

  @ApiProperty({ format: 'date-time' })
  expiresAt: string;
}

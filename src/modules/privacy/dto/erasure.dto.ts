import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { IsPlainText } from '../../../common/validation/text.js';
import { UserStatus } from '../../../generated/prisma/enums.js';
import { VERIFICATION_ID } from '../../auth/dto/register.dto.js';

/**
 * Confirms that the signed-in customer is asking: either the current
 * password, or a code sent by `POST /me/erasure/code` (for accounts
 * registered with a mobile number, which have no password).
 */
export class EraseMyAccountDto {
  @ApiPropertyOptional({
    description: 'The current password. Send this, or verificationId and code.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  password?: string;

  @ApiPropertyOptional({ description: 'From `POST /me/erasure/code`.' })
  @IsOptional()
  @Matches(VERIFICATION_ID, { message: 'verificationId is not valid' })
  verificationId?: string;

  @ApiPropertyOptional({ example: '123456' })
  @IsOptional()
  @Matches(/^\d{6}$/, { message: 'code must be six digits' })
  code?: string;
}

export class EraseUserDto {
  @ApiProperty({
    description:
      'Why the personal data is being erased, for example how the request arrived. Audited and kept: never include the person’s name or contact details.',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsPlainText()
  @MinLength(3)
  @MaxLength(500)
  reason: string;
}

export class UserErasedResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: [UserStatus.ERASED] })
  status: UserStatus;

  @ApiProperty({ format: 'date-time' })
  erasedAt: string;
}

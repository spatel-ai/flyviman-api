import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  Equals,
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PASSWORD_MIN_LENGTH } from '../../../common/crypto/password.js';
import { E164 } from '../../../common/validation/formats.js';

const E164_MESSAGE =
  'phone must be in international format, for example +919876543210';

export class RegisterDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  firstName: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  lastName: string;

  @ApiPropertyOptional({
    description: 'Register with email and password. Send this or `phone`.',
    example: 'asha@example.com',
  })
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @ApiPropertyOptional({
    format: 'password',
    minLength: PASSWORD_MIN_LENGTH,
    description: 'Required with `email`.',
  })
  @IsOptional()
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(200)
  password?: string;

  @ApiPropertyOptional({
    description: 'Register with a mobile number and one-time code. E.164.',
    example: '+919876543210',
  })
  @IsOptional()
  @Matches(E164, { message: E164_MESSAGE })
  phone?: string;

  @ApiProperty({
    description: 'Must be true: the terms and the privacy policy are accepted.',
  })
  @Equals(true, { message: 'acceptTerms must be true' })
  acceptTerms: boolean;
}

export class VerificationSentResponseDto {
  @ApiProperty({
    description:
      'Identifies this attempt. Send it back with the code to verify.',
  })
  verificationId: string;

  @ApiProperty({ enum: ['EMAIL', 'SMS'] })
  channel: 'EMAIL' | 'SMS';

  @ApiProperty({
    description: 'Where the code was sent, partly hidden.',
    example: 'a***@example.com',
  })
  destination: string;

  @ApiProperty({ description: 'Seconds until the code expires.' })
  expiresInSeconds: number;
}

const VERIFICATION_ID = /^[A-Za-z0-9_-]{20,64}$/;

export class RequestOtpDto {
  @ApiPropertyOptional({
    description: 'Sign in a customer registered with this number.',
    example: '+919876543210',
  })
  @IsOptional()
  @Matches(E164, { message: E164_MESSAGE })
  phone?: string;

  @ApiPropertyOptional({
    description: 'Send a fresh code for this open attempt instead.',
  })
  @IsOptional()
  @Matches(VERIFICATION_ID, { message: 'verificationId is not valid' })
  verificationId?: string;
}

export class VerifyOtpDto {
  @ApiProperty({
    description: 'From registration or `POST /auth/otp/request`.',
  })
  @Matches(VERIFICATION_ID, { message: 'verificationId is not valid' })
  verificationId: string;

  @ApiProperty({ example: '123456' })
  @Matches(/^\d{6}$/, { message: 'code must be six digits' })
  code: string;
}

export class ForgotPasswordDto {
  @ApiProperty({ example: 'asha@example.com' })
  @IsEmail()
  @MaxLength(254)
  email: string;
}

export class ResetPasswordDto {
  @ApiProperty({ description: 'From the emailed link.' })
  @IsString()
  @MinLength(20)
  @MaxLength(200)
  token: string;

  @ApiProperty({ format: 'password', minLength: PASSWORD_MIN_LENGTH })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(200)
  password: string;
}

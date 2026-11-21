import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AppException } from '../../common/errors/app.exception.js';
import { StrictRateLimit } from '../../common/rate-limit/rate-limit.js';
import { Role } from '../../generated/prisma/enums.js';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import { VerificationSentResponseDto } from '../auth/dto/register.dto.js';
import { EraseMyAccountDto } from './dto/erasure.dto.js';
import { type ErasureProof, ErasureService } from './erasure.service.js';

/** Exactly one way of confirming: the password, or a code with its attempt. */
function proofOf(body: EraseMyAccountDto): ErasureProof {
  const { password, verificationId, code } = body;
  if (password !== undefined && !verificationId && !code) return { password };
  if (password === undefined && verificationId && code) {
    return { verificationId, code };
  }
  throw new AppException(
    'VALIDATION_ERROR',
    'Send your password, or the code you were sent.',
    HttpStatus.BAD_REQUEST,
    [{ field: 'password', issue: 'send password, or verificationId and code' }],
  );
}

@ApiTags('me')
@ApiCookieAuth()
@StrictRateLimit()
@Controller('me/erasure')
export class MeErasureController {
  constructor(private readonly erasure: ErasureService) {}

  @Post('code')
  @Roles(Role.CUSTOMER)
  @HttpCode(202)
  @ApiOperation({
    summary: 'Send a code to confirm erasing your account',
    description:
      'For accounts without a password (registered with a mobile number), or as an alternative to it. The code goes to the mobile number, or to the email address when there is none. Send the answer’s `verificationId` with the code to `POST /me/erasure`.',
  })
  @ApiAcceptedResponse({ type: VerificationSentResponseDto })
  sendCode(
    @CurrentUser() user: AuthUser,
  ): Promise<VerificationSentResponseDto> {
    return this.erasure.sendCode(user);
  }

  @Post()
  @Roles(Role.CUSTOMER)
  @HttpCode(204)
  @ApiOperation({
    summary: 'Erase your account and personal data',
    description:
      'Irreversible. Confirmed with the current password, or with `verificationId` and `code` from `POST /me/erasure/code`. Your name, contact details, password, saved passengers, sign-ins, notifications and the personal details on past bookings and air ambulance requests (passengers, special requests, contacts, medical details and documents) are erased at once. Booking references, amounts, payments and settlements are kept for the legal and financial record, as are the records of the consents you gave (with the address they were given from) and the audit log (with the address of each action). Messages in a booking’s timeline stay, encrypted, because the timeline cannot be edited. Every sign-in ends; the email address or mobile number can be registered again. 409 `USER_ERASURE_BLOCKED` while something is still open, with one `details` entry per reason (`OPEN_BOOKINGS`, `PAYMENT_IN_PROGRESS`, `REFUND_IN_PROGRESS`, `REFUND_DUE`, `BALANCE_DUE`, `OPEN_AIR_AMBULANCE`, `RECENT_ACTIVITY`); 401 `AUTH_INVALID_CREDENTIALS` for a wrong password; 400 `AUTH_OTP_INVALID` or `AUTH_OTP_EXPIRED` for a wrong or used code.',
  })
  @ApiNoContentResponse()
  async erase(
    @CurrentUser() user: AuthUser,
    @Body() body: EraseMyAccountDto,
  ): Promise<void> {
    await this.erasure.eraseOwn(user, proofOf(body));
  }
}

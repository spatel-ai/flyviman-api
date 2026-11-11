import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { StrictRateLimit } from '../../common/rate-limit/rate-limit.js';
import { UserResponseDto } from '../users/dto/user-response.dto.js';
import {
  ACCESS_COOKIE,
  clearSessionCookies,
  REFRESH_COOKIE,
  setSessionCookies,
} from './auth.cookies.js';
import { Public } from './auth.decorators.js';
import { AuthService, ClientInfo } from './auth.service.js';
import { LoginDto } from './dto/login.dto.js';
import {
  ForgotPasswordDto,
  RegisterDto,
  RequestOtpDto,
  ResetPasswordDto,
  VerificationSentResponseDto,
  VerifyOtpDto,
} from './dto/register.dto.js';
import { RegistrationService } from './registration.service.js';
import { TokenService } from './token.service.js';

function clientInfo(request: Request): ClientInfo {
  return {
    userAgent: request.header('user-agent') ?? null,
    ipAddress: request.ip ?? null,
  };
}

@ApiTags('auth')
@StrictRateLimit()
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
    private readonly registration: RegistrationService,
  ) {}

  @Post('register')
  @Public()
  @HttpCode(202)
  @ApiOperation({
    summary: 'Register a customer',
    description:
      'With email and password, or with a mobile number. A six-digit code is sent to verify the address. The answer is the same whether or not the address is already registered.',
  })
  @ApiAcceptedResponse({ type: VerificationSentResponseDto })
  register(@Body() body: RegisterDto): Promise<VerificationSentResponseDto> {
    return this.registration.registerCustomer(body);
  }

  @Post('otp/request')
  @Public()
  @HttpCode(202)
  @ApiOperation({
    summary: 'Send a one-time code',
    description:
      'With `phone`: starts a sign-in for a customer registered with that number and answers with a `verificationId`. With `verificationId`: sends a fresh code for an attempt that is still open (400 `AUTH_OTP_EXPIRED` if it is not). The answer never reveals whether the number is registered.',
  })
  @ApiAcceptedResponse({ type: VerificationSentResponseDto })
  requestOtp(
    @Body() body: RequestOtpDto,
  ): Promise<VerificationSentResponseDto> {
    return this.registration.requestCode(body);
  }

  @Post('otp/verify')
  @Public()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Verify a one-time code and sign in',
    description:
      'With the `verificationId` from registration or `POST /auth/otp/request`. Sets the session cookies. A code works once.',
  })
  @ApiOkResponse({ type: UserResponseDto })
  verifyOtp(
    @Body() body: VerifyOtpDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<UserResponseDto> {
    return this.verify(body, request, response);
  }

  @Post('email/verify')
  @Public()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Verify an email address and sign in',
    description:
      'The same as `POST /auth/otp/verify`, kept for registrations verified by email.',
  })
  @ApiOkResponse({ type: UserResponseDto })
  verifyEmail(
    @Body() body: VerifyOtpDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<UserResponseDto> {
    return this.verify(body, request, response);
  }

  @Post('password/forgot')
  @Public()
  @HttpCode(202)
  @ApiOperation({
    summary: 'Email a password reset link',
    description: 'Always answers 202, whether or not the account exists.',
  })
  @ApiAcceptedResponse()
  async forgotPassword(@Body() body: ForgotPasswordDto): Promise<void> {
    await this.registration.forgotPassword(body.email);
  }

  @Post('password/reset')
  @Public()
  @HttpCode(204)
  @ApiOperation({
    summary: 'Choose a new password with an emailed link',
    description:
      'Also used to accept a staff invitation. The link works once, and every existing session is ended.',
  })
  @ApiNoContentResponse()
  async resetPassword(@Body() body: ResetPasswordDto): Promise<void> {
    await this.registration.resetPassword(body.token, body.password);
  }

  private async verify(
    body: VerifyOtpDto,
    request: Request,
    response: Response,
  ): Promise<UserResponseDto> {
    const { tokens, user } = await this.registration.verifyCode(
      body,
      clientInfo(request),
    );
    setSessionCookies(response, tokens, this.tokens.cookieSettings);
    return {
      id: user.id,
      email: user.email,
      phone: user.phone,
      role: user.role,
      status: user.status,
    };
  }

  @Post('login')
  @Public()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Sign in with email and password',
    description:
      'Sets the session cookies. The answer is the same for an unknown email and a wrong password.',
  })
  @ApiOkResponse({ type: UserResponseDto })
  async login(
    @Body() body: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<UserResponseDto> {
    const { tokens, user } = await this.auth.login(
      body.email,
      body.password,
      clientInfo(request),
    );
    setSessionCookies(response, tokens, this.tokens.cookieSettings);
    return {
      id: user.id,
      email: user.email,
      phone: user.phone,
      role: user.role,
      status: user.status,
    };
  }

  @Post('refresh')
  @Public()
  @HttpCode(204)
  @ApiOperation({
    summary: 'Rotate the session tokens',
    description:
      'Reads the refresh cookie and replaces all three session cookies. Each refresh token works once.',
  })
  @ApiNoContentResponse()
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const cookies = (request.cookies ?? {}) as Record<
      string,
      string | undefined
    >;
    // On failure the cookies are left alone: the request may simply have
    // lost a race with another refresh that has already set new ones.
    const tokens = await this.auth.refresh(
      cookies[REFRESH_COOKIE],
      clientInfo(request),
    );
    setSessionCookies(response, tokens, this.tokens.cookieSettings);
  }

  @Post('logout')
  @Public()
  @HttpCode(204)
  @ApiOperation({
    summary: 'Sign out',
    description:
      'Ends this sign-in and clears the session cookies. Works with an expired access token, as long as the refresh cookie is sent. Always answers 204.',
  })
  @ApiNoContentResponse()
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const cookies = (request.cookies ?? {}) as Record<
      string,
      string | undefined
    >;
    await this.auth.logout({
      accessToken: cookies[ACCESS_COOKIE],
      refreshToken: cookies[REFRESH_COOKIE],
    });
    clearSessionCookies(response, this.tokens.cookieSettings);
  }
}

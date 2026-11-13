import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { instanceToPlain } from 'class-transformer';
import { StrictRateLimit } from '../../common/rate-limit/rate-limit.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { Role } from '../../generated/prisma/enums.js';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, Public, Roles } from '../auth/auth.decorators.js';
import { VerificationSentResponseDto } from '../auth/dto/register.dto.js';
import {
  AddOperatorDocumentDto,
  OperatorDocumentResponseDto,
  OperatorProfileResponseDto,
  OperatorProfileWithAccessDto,
  RegisterOperatorDto,
  UpdateOperatorProfileDto,
} from './dto/operator.dto.js';
import { toDocumentDto, toProfileDto } from './operator.mappers.js';
import { OperatorsService } from './operators.service.js';

@ApiTags('operator')
@ApiCookieAuth()
@Controller('operator')
export class OperatorController {
  constructor(private readonly operators: OperatorsService) {}

  @Post('register')
  @Public()
  @StrictRateLimit()
  @HttpCode(202)
  @ApiOperation({
    summary: 'Register an operator organisation',
    description:
      'Creates the organisation as a draft with its first administrator, and sends a code to verify the email. The answer is the same whether or not the email is already registered.',
  })
  @ApiAcceptedResponse({ type: VerificationSentResponseDto })
  register(
    @Body() body: RegisterOperatorDto,
  ): Promise<VerificationSentResponseDto> {
    return this.operators.register(body);
  }

  @Get('profile')
  @Roles(Role.OPERATOR_ADMIN, Role.OPERATOR_STAFF)
  @ApiOperation({
    summary: 'The operator organisation and its review status',
    description:
      'Also says what the caller may do in it (`access`), so the portal shows staff only what they can use.',
  })
  @ApiOkResponse({ type: OperatorProfileWithAccessDto })
  async profile(
    @CurrentUser() user: AuthUser,
  ): Promise<OperatorProfileWithAccessDto> {
    const { operator, access } = await this.operators.accessFor(user);
    return {
      ...toProfileDto(operator, await this.operators.missing(operator)),
      access: {
        role: access.role,
        capabilities: access.capabilities,
        allAircraft: access.aircraft === 'ALL',
        aircraftIds: access.aircraft === 'ALL' ? [] : access.aircraft,
      },
    };
  }

  @Patch('profile')
  @Roles(Role.OPERATOR_ADMIN)
  @ApiOperation({
    summary: 'Update the operator organisation',
    description:
      'Not while the application is under review. Legal name, registration number and tax number are locked after approval.',
  })
  @ApiOkResponse({ type: OperatorProfileResponseDto })
  async update(
    @CurrentUser() user: AuthUser,
    @Body() body: UpdateOperatorProfileDto,
  ): Promise<OperatorProfileResponseDto> {
    const operator = await this.operators.updateProfile(
      user.id,
      // Validated and whitelisted by the DTO; addresses are stored as JSON.
      instanceToPlain(body) as Prisma.OperatorUpdateInput,
    );
    return toProfileDto(operator, await this.operators.missing(operator));
  }

  @Post('profile/submit')
  @Roles(Role.OPERATOR_ADMIN)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Submit the application for review',
    description:
      'Needs company details, at least one service category, and the required compliance documents.',
  })
  @ApiOkResponse({ type: OperatorProfileResponseDto })
  async submit(
    @CurrentUser() user: AuthUser,
  ): Promise<OperatorProfileResponseDto> {
    const current = await this.operators.forMember(user.id);
    const operator = await this.operators.transition(
      user,
      current.id,
      'submit',
    );
    return toProfileDto(operator, []);
  }

  @Get('documents')
  @Roles(Role.OPERATOR_ADMIN)
  @ApiOperation({ summary: 'Compliance documents' })
  @ApiOkResponse({ type: [OperatorDocumentResponseDto] })
  async documents(
    @CurrentUser() user: AuthUser,
  ): Promise<OperatorDocumentResponseDto[]> {
    const operator = await this.operators.forMember(user.id);
    return (await this.operators.listDocuments(operator.id)).map(toDocumentDto);
  }

  @Post('documents')
  @Roles(Role.OPERATOR_ADMIN)
  @ApiOperation({
    summary: 'Add a compliance document',
    description: 'Upload the file first with `POST /uploads/presign`.',
  })
  @ApiCreatedResponse({ type: OperatorDocumentResponseDto })
  async addDocument(
    @CurrentUser() user: AuthUser,
    @Body() body: AddOperatorDocumentDto,
  ): Promise<OperatorDocumentResponseDto> {
    return toDocumentDto(await this.operators.addDocument(user.id, body));
  }

  @Delete('documents/:id')
  @Roles(Role.OPERATOR_ADMIN)
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a compliance document' })
  @ApiNoContentResponse()
  async removeDocument(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.operators.removeDocument(user.id, id);
  }
}

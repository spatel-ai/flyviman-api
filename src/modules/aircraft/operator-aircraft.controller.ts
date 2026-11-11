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
  Query,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { instanceToPlain } from 'class-transformer';
import { Paginated } from '../../common/dto/paginated.js';
import { Role } from '../../generated/prisma/enums.js';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import { AircraftService } from './aircraft.service.js';
import {
  toAircraftDto,
  toDocumentDto,
  toMediaDto,
  toSummaryDto,
} from './aircraft.mappers.js';
import {
  AddAircraftDocumentDto,
  AddAircraftMediaDto,
  AircraftDocumentResponseDto,
  AircraftMediaResponseDto,
  AircraftResponseDto,
  AircraftSummaryResponseDto,
  CreateAircraftDto,
  ListAircraftQueryDto,
  SetAvailabilityStatusDto,
  UpdateAircraftDto,
} from './dto/aircraft.dto.js';

@ApiTags('operator-aircraft')
@ApiCookieAuth()
@Controller('operator/aircraft')
export class OperatorAircraftController {
  constructor(private readonly aircraft: AircraftService) {}

  @Get()
  @Roles(Role.OPERATOR_ADMIN)
  @ApiOperation({ summary: "List this operator's aircraft" })
  @ApiOkResponse({ type: [AircraftSummaryResponseDto] })
  async list(
    @CurrentUser() user: AuthUser,
    @Query() query: ListAircraftQueryDto,
  ): Promise<Paginated<AircraftSummaryResponseDto>> {
    const page = await this.aircraft.list(user.id, query);
    return new Paginated(
      page.items.map(toSummaryDto),
      page.page,
      page.pageSize,
      page.total,
    );
  }

  @Post()
  @Roles(Role.OPERATOR_ADMIN)
  @ApiOperation({ summary: 'Create an aircraft profile' })
  @ApiCreatedResponse({ type: AircraftResponseDto })
  async create(
    @CurrentUser() user: AuthUser,
    @Body() body: CreateAircraftDto,
  ): Promise<AircraftResponseDto> {
    return toAircraftDto(await this.aircraft.create(user.id, body));
  }

  @Get(':id')
  @Roles(Role.OPERATOR_ADMIN)
  @ApiOperation({ summary: 'Aircraft detail' })
  @ApiOkResponse({ type: AircraftResponseDto })
  async get(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AircraftResponseDto> {
    return toAircraftDto(await this.aircraft.get(user.id, id));
  }

  @Patch(':id')
  @Roles(Role.OPERATOR_ADMIN)
  @ApiOperation({
    summary: 'Update an aircraft profile',
    description:
      'Editing a material field on an approved aircraft returns it to PENDING_REVIEW. Photos and specifications do not.',
  })
  @ApiOkResponse({ type: AircraftResponseDto })
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateAircraftDto,
  ): Promise<AircraftResponseDto> {
    return toAircraftDto(
      await this.aircraft.update(
        user.id,
        id,
        instanceToPlain(body) as Parameters<AircraftService['update']>[2],
      ),
    );
  }

  @Post(':id/submit')
  @Roles(Role.OPERATOR_ADMIN)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Submit an aircraft for approval',
    description:
      'Only an approved operator can submit. Needs a home base, range and the required documents (registration, airworthiness, insurance).',
  })
  @ApiOkResponse({ type: AircraftResponseDto })
  async submit(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AircraftResponseDto> {
    return toAircraftDto(await this.aircraft.submit(user, id));
  }

  @Patch(':id/availability-status')
  @Roles(Role.OPERATOR_ADMIN)
  @ApiOperation({ summary: 'Set available, unavailable or maintenance' })
  @ApiOkResponse({ type: AircraftResponseDto })
  async setAvailability(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SetAvailabilityStatusDto,
  ): Promise<AircraftResponseDto> {
    return toAircraftDto(
      await this.aircraft.setAvailabilityStatus(user.id, id, body.status),
    );
  }

  @Post(':id/media')
  @Roles(Role.OPERATOR_ADMIN)
  @ApiOperation({
    summary: 'Add a photo or floor plan',
    description:
      'Upload first with `POST /uploads/presign` using purpose AIRCRAFT_PHOTO or AIRCRAFT_FLOOR_PLAN.',
  })
  @ApiCreatedResponse({ type: AircraftMediaResponseDto })
  async addMedia(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AddAircraftMediaDto,
  ): Promise<AircraftMediaResponseDto> {
    return toMediaDto(await this.aircraft.addMedia(user.id, id, body));
  }

  @Delete(':id/media/:mediaId')
  @Roles(Role.OPERATOR_ADMIN)
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a photo or floor plan' })
  @ApiNoContentResponse()
  async removeMedia(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('mediaId', ParseUUIDPipe) mediaId: string,
  ): Promise<void> {
    await this.aircraft.removeMedia(user.id, id, mediaId);
  }

  @Post(':id/documents')
  @Roles(Role.OPERATOR_ADMIN)
  @ApiOperation({
    summary: 'Add an aircraft document',
    description:
      'Upload first with `POST /uploads/presign` using purpose AIRCRAFT_DOCUMENT. Adding a document to an approved aircraft returns it to PENDING_REVIEW.',
  })
  @ApiCreatedResponse({ type: AircraftDocumentResponseDto })
  async addDocument(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AddAircraftDocumentDto,
  ): Promise<AircraftDocumentResponseDto> {
    return toDocumentDto(await this.aircraft.addDocument(user.id, id, body));
  }

  @Delete(':id/documents/:documentId')
  @Roles(Role.OPERATOR_ADMIN)
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove an aircraft document' })
  @ApiNoContentResponse()
  async removeDocument(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
  ): Promise<void> {
    await this.aircraft.removeDocument(user.id, id, documentId);
  }
}

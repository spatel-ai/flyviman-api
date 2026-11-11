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
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { day } from '../../common/validation/formats.js';
import { Role } from '../../generated/prisma/enums.js';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import { CustomersService, PassengerRecord } from './customers.service.js';
import {
  CreatePassengerDto,
  PassengerResponseDto,
  UpdatePassengerDto,
} from './dto/passenger.dto.js';

function toDto(passenger: PassengerRecord): PassengerResponseDto {
  return {
    ...passenger,
    dateOfBirth: day(passenger.dateOfBirth),
    documentExpiry: day(passenger.documentExpiry),
  };
}

@ApiTags('me')
@ApiCookieAuth()
@Roles(Role.CUSTOMER)
@Controller('me/passengers')
export class PassengersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @ApiOperation({ summary: 'Saved passengers' })
  @ApiOkResponse({ type: [PassengerResponseDto] })
  async list(@CurrentUser() user: AuthUser): Promise<PassengerResponseDto[]> {
    return (await this.customers.listPassengers(user.id)).map(toDto);
  }

  @Post()
  @ApiOperation({ summary: 'Save a passenger' })
  @ApiCreatedResponse({ type: PassengerResponseDto })
  async create(
    @CurrentUser() user: AuthUser,
    @Body() body: CreatePassengerDto,
  ): Promise<PassengerResponseDto> {
    return toDto(await this.customers.addPassenger(user.id, body));
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a saved passenger' })
  @ApiOkResponse({ type: PassengerResponseDto })
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdatePassengerDto,
  ): Promise<PassengerResponseDto> {
    return toDto(await this.customers.updatePassenger(user.id, id, body));
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a saved passenger' })
  @ApiNoContentResponse()
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.customers.removePassenger(user.id, id);
  }
}

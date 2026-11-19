import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Enquiry } from '../../generated/prisma/client.js';
import { Paginated } from '../../common/dto/paginated.js';
import { Role } from '../../generated/prisma/enums.js';
import { Roles } from '../auth/auth.decorators.js';
import {
  AdminEnquiryResponseDto,
  AdminEnquirySummaryDto,
  ListEnquiriesDto,
} from './dto/admin-enquiries.dto.js';
import { EnquiriesService } from './enquiries.service.js';

function toDto(row: Enquiry): AdminEnquiryResponseDto {
  return {
    id: row.id,
    reference: row.reference,
    name: row.name,
    email: row.email,
    phone: row.phone,
    topic: row.topic,
    message: row.message,
    handledAt: row.handledAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function toSummary(row: Enquiry): AdminEnquirySummaryDto {
  return {
    id: row.id,
    reference: row.reference,
    name: row.name,
    topic: row.topic,
    handledAt: row.handledAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

@ApiTags('admin: enquiries')
@ApiCookieAuth()
@Controller('admin/enquiries')
export class AdminEnquiriesController {
  constructor(private readonly enquiries: EnquiriesService) {}

  @Get()
  @Roles(Role.OPS, Role.SUPER_ADMIN)
  @ApiOperation({
    summary: 'List sales enquiries',
    description:
      'Newest first. Summary rows only; contact details and the message come with the single enquiry. Personal data is never logged.',
  })
  @ApiOkResponse({ type: [AdminEnquirySummaryDto] })
  async list(
    @Query() query: ListEnquiriesDto,
  ): Promise<Paginated<AdminEnquirySummaryDto>> {
    const result = await this.enquiries.list(query);
    return new Paginated(
      result.items.map(toSummary),
      result.page,
      result.pageSize,
      result.total,
    );
  }

  @Get(':id')
  @Roles(Role.OPS, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'One sales enquiry' })
  @ApiOkResponse({ type: AdminEnquiryResponseDto })
  async detail(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AdminEnquiryResponseDto> {
    return toDto(await this.enquiries.getDetail(id));
  }

  @Post(':id/handle')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.OPS, Role.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Mark an enquiry handled',
    description:
      'Sets `handledAt` and writes an audit record (topic and ids only). Repeating the call on a handled enquiry changes nothing and records nothing.',
  })
  @ApiOkResponse({ type: AdminEnquiryResponseDto })
  async handle(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AdminEnquiryResponseDto> {
    return toDto(await this.enquiries.markHandled(id));
  }
}

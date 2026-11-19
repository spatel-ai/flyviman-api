import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Paginated } from '../../common/dto/paginated.js';
import { Role } from '../../generated/prisma/enums.js';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, Public, Roles } from '../auth/auth.decorators.js';
import {
  EmptyLegInterestResponseDto,
  EmptyLegResponseDto,
  PublicEmptyLegQueryDto,
} from './dto/empty-leg.dto.js';
import { EmptyLegsService } from './empty-legs.service.js';

@ApiTags('empty-legs')
@Controller('empty-legs')
export class EmptyLegsController {
  constructor(private readonly emptyLegs: EmptyLegsService) {}

  @Get()
  @Public()
  @ApiOperation({
    summary: 'Listed empty-leg offers',
    description:
      'Published offers still valid, on an approved, available aircraft with current documents, of an approved operator. Soonest departure first. `from` and `to` are India dates matched against the departure window; `maxPrice` is in paise.',
  })
  @ApiOkResponse({ type: [EmptyLegResponseDto] })
  async list(
    @Query() query: PublicEmptyLegQueryDto,
  ): Promise<Paginated<EmptyLegResponseDto>> {
    const page = await this.emptyLegs.publicList(query);
    return new Paginated(
      page.items.map((row) => this.emptyLegs.toPublic(row)),
      page.page,
      page.pageSize,
      page.total,
    );
  }

  @Get(':id')
  @Public()
  @ApiOperation({
    summary: 'Empty-leg offer detail',
    description:
      '410 `EMPTY_LEG_EXPIRED` or `EMPTY_LEG_WITHDRAWN` for an offer that was listed and has ended; 404 for any other offer that is not listed.',
  })
  @ApiOkResponse({ type: EmptyLegResponseDto })
  async detail(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<EmptyLegResponseDto> {
    return this.emptyLegs.toPublic(await this.emptyLegs.listed(id));
  }

  @Post(':id/interest')
  @Roles(Role.CUSTOMER)
  @ApiCookieAuth()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Follow an offer for change alerts',
    description:
      'Listed offers only (404 or 410 otherwise). Repeating it changes nothing. Alerts go in the app and by email when the offer changes, is withdrawn or expires.',
  })
  @ApiOkResponse({ type: EmptyLegInterestResponseDto })
  async register(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<EmptyLegInterestResponseDto> {
    await this.emptyLegs.registerInterest(user, id);
    return { emptyLegId: id, interested: true };
  }

  @Delete(':id/interest')
  @Roles(Role.CUSTOMER)
  @ApiCookieAuth()
  @HttpCode(204)
  @ApiOperation({
    summary: 'Stop alerts for an offer',
    description: 'Succeeds whether or not the caller was following it.',
  })
  @ApiNoContentResponse()
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.emptyLegs.removeInterest(user, id);
  }
}

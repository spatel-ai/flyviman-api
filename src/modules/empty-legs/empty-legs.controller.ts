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
import {
  CurrentUser,
  OptionalUser,
  Public,
  PublicOptionalUser,
  Roles,
} from '../auth/auth.decorators.js';
import {
  EmptyLegDetailResponseDto,
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
  @PublicOptionalUser()
  @ApiOperation({
    summary: 'Empty-leg offer detail',
    description:
      '410 `EMPTY_LEG_EXPIRED` or `EMPTY_LEG_WITHDRAWN` for an offer that was listed and has ended; 404 for any other offer that is not listed. `interested` tells a signed-in customer whether they follow it; the answer is then `Cache-Control: private, no-store`.',
  })
  @ApiOkResponse({ type: EmptyLegDetailResponseDto })
  async detail(
    @OptionalUser() user: AuthUser | null,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<EmptyLegDetailResponseDto> {
    const row = await this.emptyLegs.listed(id);
    const interested =
      user?.role === Role.CUSTOMER
        ? await this.emptyLegs.isInterested(user.id, id)
        : false;
    return { ...this.emptyLegs.toPublic(row), interested };
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

import {
  Body,
  Controller,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Role, UserStatus } from '../../generated/prisma/enums.js';
import { Roles } from '../auth/auth.decorators.js';
import { EraseUserDto, UserErasedResponseDto } from './dto/erasure.dto.js';
import { ErasureService } from './erasure.service.js';

@ApiTags('admin: users')
@ApiCookieAuth()
@Controller('admin/users')
export class AdminErasureController {
  constructor(private readonly erasure: ErasureService) {}

  @Post(':id/erase')
  @Roles(Role.SUPER_ADMIN)
  @HttpCode(200)
  @ApiOperation({
    summary: "Erase a customer's personal data",
    description:
      'For an erasure request received another way (email, letter). Customer accounts only. Irreversible; needs a reason and is audited as `user.erase` with counts only. The same data is erased and kept as for `POST /me/erasure`, and the same 409 `USER_ERASURE_BLOCKED` applies. 409 `USER_INVALID_TRANSITION` for an internal staff or operator account, or one already erased.',
  })
  @ApiOkResponse({ type: UserErasedResponseDto })
  async erase(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: EraseUserDto,
  ): Promise<UserErasedResponseDto> {
    const erasedAt = await this.erasure.eraseByAdmin(id, body.reason);
    return { id, status: UserStatus.ERASED, erasedAt: erasedAt.toISOString() };
  }
}

import { Controller, Get, Param } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/auth.decorators.js';
import { ContentService } from './content.service.js';
import { PolicyResponseDto } from './dto/policy-response.dto.js';

@ApiTags('content')
@Public()
@Controller('content')
export class ContentController {
  constructor(private readonly content: ContentService) {}

  @Get('policies/:slug')
  @ApiOperation({
    summary: 'A published policy',
    description: 'For example `terms` or `privacy`.',
  })
  @ApiOkResponse({ type: PolicyResponseDto })
  async policy(@Param('slug') slug: string): Promise<PolicyResponseDto> {
    const policy = await this.content.getPolicy(slug);
    return { ...policy, publishedAt: policy.publishedAt.toISOString() };
  }
}

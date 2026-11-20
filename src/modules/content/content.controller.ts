import { Controller, Get, Header, Param } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/auth.decorators.js';
import { ContentService } from './content.service.js';
import {
  PolicyResponseDto,
  PublicContentItemResponseDto,
} from './dto/policy-response.dto.js';

/** Public text that changes by hand: a minute in shared caches is enough. */
const PUBLIC_CACHE = 'public, max-age=60, stale-while-revalidate=300';

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

  @Get('banners')
  @Header('Cache-Control', PUBLIC_CACHE)
  @ApiOperation({
    summary: 'Published banners',
    description:
      'In display order; drafts and unpublished banners never appear. Plain text. Cacheable for a minute.',
  })
  @ApiOkResponse({ type: [PublicContentItemResponseDto] })
  banners(): Promise<PublicContentItemResponseDto[]> {
    return this.content.listPublished('BANNER');
  }

  @Get('faqs')
  @Header('Cache-Control', PUBLIC_CACHE)
  @ApiOperation({
    summary: 'Published questions and answers',
    description:
      'In display order; drafts never appear. `title` is the question, `body` the answer, plain text. Cacheable for a minute.',
  })
  @ApiOkResponse({ type: [PublicContentItemResponseDto] })
  faqs(): Promise<PublicContentItemResponseDto[]> {
    return this.content.listPublished('FAQ');
  }
}

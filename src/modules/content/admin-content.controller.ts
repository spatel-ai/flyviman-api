import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { ContentItem } from '../../generated/prisma/client.js';
import { Role } from '../../generated/prisma/enums.js';
import { Roles } from '../auth/auth.decorators.js';
import {
  AdminContentService,
  type ManagedKind,
} from './admin-content.service.js';
import {
  AdminPolicyResponseDto,
  ContentItemResponseDto,
  CreateContentItemDto,
  NotificationTemplateResponseDto,
  PublishPolicyDto,
  UpdateContentItemDto,
  UpdateNotificationTemplateDto,
} from './dto/admin-content.dto.js';
import { PolicySlugPipe, TemplateKeyPipe } from './content-params.js';

function toItem(item: ContentItem): ContentItemResponseDto {
  return {
    id: item.id,
    slug: item.slug,
    title: item.title,
    body: item.body,
    region: item.region,
    sortOrder: item.sortOrder,
    publishedAt: item.publishedAt?.toISOString() ?? null,
    updatedAt: item.updatedAt.toISOString(),
  };
}

function toPolicy(
  item: ContentItem,
  versionCount: number,
): AdminPolicyResponseDto {
  return {
    slug: item.slug,
    title: item.title,
    body: item.body,
    version: item.version,
    publishedAt: item.publishedAt?.toISOString() ?? null,
    versionCount,
  };
}

const ADMIN = [Role.OPS, Role.SUPER_ADMIN] as const;

@ApiTags('admin: content')
@ApiCookieAuth()
@Controller('admin/content/banners')
export class AdminBannersController {
  private readonly kind: ManagedKind = 'BANNER';

  constructor(private readonly content: AdminContentService) {}

  @Get()
  @Roles(...ADMIN)
  @ApiOperation({
    summary: 'List banners',
    description: 'Drafts and published, in display order.',
  })
  @ApiOkResponse({ type: [ContentItemResponseDto] })
  async list() {
    return (await this.content.list(this.kind)).map(toItem);
  }

  @Post()
  @Roles(...ADMIN)
  @ApiOperation({
    summary: 'Create a banner',
    description: 'A draft unless `published` is true. Audited.',
  })
  @ApiCreatedResponse({ type: ContentItemResponseDto })
  async create(@Body() body: CreateContentItemDto) {
    return toItem(await this.content.create(this.kind, body));
  }

  @Patch(':id')
  @Roles(...ADMIN)
  @ApiOperation({
    summary: 'Change, publish or unpublish a banner',
    description: 'Audited with the values before and after.',
  })
  @ApiOkResponse({ type: ContentItemResponseDto })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateContentItemDto,
  ) {
    return toItem(await this.content.update(this.kind, id, body));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles(...ADMIN)
  @ApiOperation({ summary: 'Delete a banner', description: 'Audited.' })
  @ApiNoContentResponse()
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.content.remove(this.kind, id);
  }
}

@ApiTags('admin: content')
@ApiCookieAuth()
@Controller('admin/content/faqs')
export class AdminFaqsController {
  private readonly kind: ManagedKind = 'FAQ';

  constructor(private readonly content: AdminContentService) {}

  @Get()
  @Roles(...ADMIN)
  @ApiOperation({
    summary: 'List questions and answers',
    description: 'Drafts and published, in display order.',
  })
  @ApiOkResponse({ type: [ContentItemResponseDto] })
  async list() {
    return (await this.content.list(this.kind)).map(toItem);
  }

  @Post()
  @Roles(...ADMIN)
  @ApiOperation({
    summary: 'Create a question and answer',
    description: '`title` is the question, `body` the answer. Audited.',
  })
  @ApiCreatedResponse({ type: ContentItemResponseDto })
  async create(@Body() body: CreateContentItemDto) {
    return toItem(await this.content.create(this.kind, body));
  }

  @Patch(':id')
  @Roles(...ADMIN)
  @ApiOperation({
    summary: 'Change, publish or unpublish an entry',
    description: 'Audited with the values before and after.',
  })
  @ApiOkResponse({ type: ContentItemResponseDto })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateContentItemDto,
  ) {
    return toItem(await this.content.update(this.kind, id, body));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles(...ADMIN)
  @ApiOperation({ summary: 'Delete an entry', description: 'Audited.' })
  @ApiNoContentResponse()
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.content.remove(this.kind, id);
  }
}

@ApiTags('admin: content')
@ApiCookieAuth()
@Controller('admin/content')
export class AdminPoliciesController {
  constructor(private readonly content: AdminContentService) {}

  @Get('policies')
  @Roles(...ADMIN)
  @ApiOperation({ summary: 'List policies and terms' })
  @ApiOkResponse({ type: [AdminPolicyResponseDto] })
  async policies() {
    return (await this.content.listPolicies()).map((row) =>
      toPolicy(row.item, row.versionCount),
    );
  }

  @Put('policies/:slug')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Publish a new version of a policy',
    description:
      'Always a new version: the text customers accepted is kept and never overwritten. The version is the UTC date, with `.2`, `.3` for further versions that day. Send `baseVersion` (the `versionCount` loaded) to be refused with 409 `CONTENT_VERSION_CONFLICT` if another version was published meanwhile; nothing is written. Sending the current text again is refused with 422 `CONTENT_UNCHANGED`. Audited.',
  })
  @ApiOkResponse({ type: AdminPolicyResponseDto })
  async publishPolicy(
    @Param('slug', PolicySlugPipe) slug: string,
    @Body() body: PublishPolicyDto,
  ) {
    const { item, versionCount } = await this.content.publishPolicy(slug, body);
    return toPolicy(item, versionCount);
  }

  @Get('notification-templates')
  @Roles(...ADMIN)
  @ApiOperation({
    summary: 'List notification templates',
    description:
      'Every built-in template with the wording now in use and the placeholders it needs.',
  })
  @ApiOkResponse({ type: [NotificationTemplateResponseDto] })
  templates() {
    return this.content.listTemplates();
  }

  @Put('notification-templates/:key')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Update a notification template',
    description:
      'The channel is in the body. The text must keep every placeholder the built-in wording uses and add none (400 `VALIDATION_ERROR` otherwise). Send `baseVersion` (the `version` loaded): 409 `CONTENT_VERSION_CONFLICT` if the template was changed meanwhile; nothing is written. Audited with the wording before and after.',
  })
  @ApiOkResponse({ type: NotificationTemplateResponseDto })
  updateTemplate(
    @Param('key', TemplateKeyPipe) key: string,
    @Body() body: UpdateNotificationTemplateDto,
  ) {
    return this.content.updateTemplate(key, body.channel, body);
  }
}

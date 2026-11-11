import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthUser } from '../auth/auth-user.js';
import { AnyRole, CurrentUser } from '../auth/auth.decorators.js';
import { DocumentsService } from './documents.service.js';
import {
  DownloadLinkResponseDto,
  PresignUploadDto,
  PresignUploadResponseDto,
} from './dto/presign-upload.dto.js';

@ApiTags('documents')
@ApiCookieAuth()
@AnyRole()
@Controller()
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Post('uploads/presign')
  @ApiOperation({
    summary: 'Get a signed URL to upload a file to',
    description:
      'Send the file to `upload.url` with `upload.method` and `upload.headers`, then attach `fileId` to a record. PDF, JPEG or PNG, 10 MB at most.',
  })
  @ApiCreatedResponse({ type: PresignUploadResponseDto })
  async presign(
    @CurrentUser() user: AuthUser,
    @Body() body: PresignUploadDto,
  ): Promise<PresignUploadResponseDto> {
    const { fileId, upload } = await this.documents.presign(user, body);
    return {
      fileId,
      upload: { ...upload, expiresAt: upload.expiresAt.toISOString() },
    };
  }

  @Get('documents/:id/download')
  @ApiOperation({
    summary: 'Get a short-lived link to download a file',
    description: 'Answers 404 for a file the caller may not read.',
  })
  @ApiOkResponse({ type: DownloadLinkResponseDto })
  async download(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<DownloadLinkResponseDto> {
    const link = await this.documents.downloadFor(user, id);
    return { url: link.url, expiresAt: link.expiresAt.toISOString() };
  }
}

import { createReadStream } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import {
  Controller,
  UseGuards,
  Get,
  HttpStatus,
  Param,
  Put,
  Req,
  Res,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { LocalStorageGuard } from './local-storage.guard.js';
import type { Request, Response } from 'express';
import { AppException } from '../../common/errors/app.exception.js';
import { Public, SkipCsrf } from '../../modules/auth/auth.decorators.js';
import { matchesDeclaredType } from './file-signature.js';
import {
  MockStorageProvider,
  MockStorageTicket,
} from './mock-storage.provider.js';

/** A neutral download name: the real one is not carried in the ticket. */
const EXTENSIONS: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

function refuse(status: HttpStatus, code: string, message: string): never {
  throw new AppException(code, message, status);
}

/**
 * The endpoints the local-disk store's signed URLs point at: development and
 * tests, or a proof of concept with STORAGE_PROVIDER=local (D-064).
 * Authorisation is the signed ticket in the URL, exactly as with a bucket,
 * so these routes take no session and are exempt from the CSRF check.
 */
@ApiExcludeController()
@UseGuards(LocalStorageGuard)
@Public()
@SkipCsrf()
@Controller('dev/storage')
export class MockStorageController {
  constructor(private readonly storage: MockStorageProvider) {}

  @Put(':token')
  async upload(
    @Param('token') token: string,
    @Req() request: Request,
  ): Promise<{ stored: true }> {
    const ticket = this.ticket(token, 'put');
    if (request.header('content-type') !== ticket.contentType) {
      refuse(
        HttpStatus.BAD_REQUEST,
        'UPLOAD_TYPE_MISMATCH',
        'The Content-Type does not match the one this upload was issued for.',
      );
    }

    const limit = ticket.maxBytes ?? 0;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > limit) {
        refuse(
          HttpStatus.PAYLOAD_TOO_LARGE,
          'UPLOAD_TOO_LARGE',
          'The file is larger than allowed.',
        );
      }
      chunks.push(chunk);
    }
    const content = Buffer.concat(chunks);
    if (!matchesDeclaredType(ticket.contentType, content.subarray(0, 16))) {
      refuse(
        HttpStatus.BAD_REQUEST,
        'UPLOAD_TYPE_MISMATCH',
        'The file content does not match its declared type.',
      );
    }

    const path = await this.storage.ensureFolder(ticket.key);
    await rm(path, { force: true });
    await writeFile(path, content, { flag: 'wx' });
    return { stored: true };
  }

  @Get(':token')
  async download(
    @Param('token') token: string,
    @Res() response: Response,
  ): Promise<void> {
    const ticket = this.ticket(token, 'get');
    if (!(await this.storage.stat(ticket.key))) {
      refuse(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'File not found.');
    }
    const name = `file.${EXTENSIONS[ticket.contentType] ?? 'bin'}`;
    response.setHeader('Content-Type', ticket.contentType);
    response.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'private, no-store');
    // Helmet's default (same-origin) would stop the web app, on another
    // origin, showing a photo. A bucket sets no such header; the signed,
    // expiring ticket is the authorisation, as it is there.
    response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    createReadStream(this.storage.pathFor(ticket.key)).pipe(response);
  }

  private ticket(
    token: string,
    op: MockStorageTicket['op'],
  ): MockStorageTicket {
    const ticket = this.storage.verify(token);
    if (!ticket || ticket.op !== op) {
      refuse(
        HttpStatus.FORBIDDEN,
        'FORBIDDEN',
        'This link is not valid or has expired.',
      );
    }
    return ticket;
  }
}

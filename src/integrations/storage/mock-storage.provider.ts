import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  SignedDownload,
  SignedUpload,
  StorageProvider,
  StoredObject,
} from './storage.provider.js';

export interface MockStorageTicket {
  op: 'put' | 'get';
  key: string;
  contentType: string;
  maxBytes?: number;
  fileName?: string;
  exp: number;
}

const UPLOAD_SECONDS = 10 * 60;
const DOWNLOAD_SECONDS = 5 * 60;
const SAFE_KEY = /^[A-Za-z0-9/_-]+$/;

/**
 * Local-disk stand-in for a private bucket. "Signed URLs" point back at this
 * API (mock-storage.controller.ts) and carry an HMAC-signed, expiring ticket,
 * so the flow matches a real bucket: no session is involved in the transfer.
 */
@Injectable()
export class MockStorageProvider extends StorageProvider {
  private readonly root: string;
  private readonly secret: string;
  private readonly baseUrl: string;

  constructor(config: ConfigService) {
    super();
    this.root = resolve(config.getOrThrow<string>('STORAGE_DIR'));
    this.secret = `storage:${config.getOrThrow<string>('JWT_ACCESS_SECRET')}`;
    const origin =
      config.get<string>('API_PUBLIC_URL') ??
      `http://localhost:${config.getOrThrow<number>('PORT')}`;
    this.baseUrl = `${origin.replace(/\/+$/, '')}/api/v1/dev/storage`;
  }

  async createUploadUrl(input: {
    key: string;
    contentType: string;
    maxBytes: number;
  }): Promise<SignedUpload> {
    const exp = Date.now() + UPLOAD_SECONDS * 1000;
    const token = this.sign({ op: 'put', exp, ...input });
    return {
      url: `${this.baseUrl}/${token}`,
      method: 'PUT',
      headers: { 'Content-Type': input.contentType },
      expiresAt: new Date(exp),
    };
  }

  async createDownloadUrl(input: {
    key: string;
    fileName: string;
    contentType: string;
  }): Promise<SignedDownload> {
    const exp = Date.now() + DOWNLOAD_SECONDS * 1000;
    // The ticket is readable in the URL (and so in any access log), so the
    // person's original file name stays out of it (D-064).
    const token = this.sign({
      op: 'get',
      exp,
      key: input.key,
      contentType: input.contentType,
    });
    return { url: `${this.baseUrl}/${token}`, expiresAt: new Date(exp) };
  }

  async stat(key: string): Promise<StoredObject | null> {
    try {
      const info = await stat(this.pathFor(key));
      return { sizeBytes: info.size };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  /** Where the mock keeps the object. Refuses keys that could leave the root. */
  pathFor(key: string): string {
    if (!SAFE_KEY.test(key) || key.includes('..')) {
      throw new Error('Invalid storage key');
    }
    return join(this.root, key);
  }

  async ensureFolder(key: string): Promise<string> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    return path;
  }

  /** Returns the ticket, or `null` if the token is forged or expired. */
  verify(token: string): MockStorageTicket | null {
    const [payload, signature] = token.split('.');
    if (!payload || !signature) return null;
    const expected = Buffer.from(this.mac(payload));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      return null;
    }
    try {
      const ticket = JSON.parse(
        Buffer.from(payload, 'base64url').toString('utf8'),
      ) as MockStorageTicket;
      return ticket.exp > Date.now() ? ticket : null;
    } catch {
      return null;
    }
  }

  private sign(ticket: MockStorageTicket): string {
    const payload = Buffer.from(JSON.stringify(ticket)).toString('base64url');
    return `${payload}.${this.mac(payload)}`;
  }

  private mac(payload: string): string {
    return createHmac('sha256', this.secret)
      .update(payload)
      .digest('base64url');
  }
}

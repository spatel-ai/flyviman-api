import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const VERSION = 'v1';
const TAG_BYTES = 16;

/**
 * Application-level encryption for sensitive columns (AES-256-GCM). Columns
 * that use it are listed in docs/architecture/security-rbac.md.
 */
@Injectable()
export class FieldCipher {
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    this.key = Buffer.from(
      config.getOrThrow<string>('DATA_ENCRYPTION_KEY'),
      'base64',
    );
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv, {
      authTagLength: TAG_BYTES,
    });
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return [VERSION, iv, cipher.getAuthTag(), body]
      .map((part) =>
        typeof part === 'string' ? part : part.toString('base64url'),
      )
      .join('.');
  }

  decrypt(stored: string): string {
    const [version, iv, tag, body] = stored.split('.');
    if (version !== VERSION || !iv || !tag || body === undefined) {
      throw new Error('Unreadable encrypted value');
    }
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key,
      Buffer.from(iv, 'base64url'),
      { authTagLength: TAG_BYTES },
    );
    const authTag = Buffer.from(tag, 'base64url');
    // A shortened tag would be far easier to forge.
    if (authTag.length !== TAG_BYTES) {
      throw new Error('Unreadable encrypted value');
    }
    decipher.setAuthTag(authTag);
    return Buffer.concat([
      decipher.update(Buffer.from(body, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}

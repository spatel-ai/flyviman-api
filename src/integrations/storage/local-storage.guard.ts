import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Opens the local-disk storage routes when local storage is in use: with
 * development tools on, or with STORAGE_PROVIDER=local (D-064). Every
 * request is still authorised by its HMAC-signed, expiring ticket.
 */
@Injectable()
export class LocalStorageGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(): boolean {
    if (
      this.config.get<boolean>('ENABLE_DEV_TOOLS') !== true &&
      this.config.get<string>('STORAGE_PROVIDER') !== 'local'
    ) {
      throw new NotFoundException();
    }
    return true;
  }
}

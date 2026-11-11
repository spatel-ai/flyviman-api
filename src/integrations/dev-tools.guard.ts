import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Makes a development-only route not exist unless ENABLE_DEV_TOOLS is on.
 * The flag comes from the validated configuration, which refuses to start
 * with it set in production, and defaults to off.
 */
@Injectable()
export class DevToolsGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(): boolean {
    if (this.config.get<boolean>('ENABLE_DEV_TOOLS') !== true) {
      throw new NotFoundException();
    }
    return true;
  }
}

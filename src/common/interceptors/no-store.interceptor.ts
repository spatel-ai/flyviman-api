import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { Observable } from 'rxjs';
import { IS_PUBLIC } from '../../modules/auth/auth.decorators.js';

/**
 * Keeps every response of a signed-in route out of shared HTTP caches, so
 * personal data does not outlive the session on a shared machine. Public
 * routes keep their own headers. Set before the handler runs, so a handler
 * that sets its own `Cache-Control` still wins.
 */
@Injectable()
export class NoStoreInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(
      IS_PUBLIC,
      [context.getHandler(), context.getClass()],
    );
    if (isPublic !== true) {
      const response = context.switchToHttp().getResponse<Response>();
      if (!response.getHeader('Cache-Control')) {
        response.setHeader('Cache-Control', 'private, no-store');
      }
    }
    return next.handle();
  }
}

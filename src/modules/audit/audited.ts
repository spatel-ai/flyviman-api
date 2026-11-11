import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { mergeMap, Observable } from 'rxjs';
import { AuditService } from './audit.service.js';

export interface AuditedOptions {
  action: string;
  entityType: string;
  /** Route parameter holding the entity ID. Defaults to `id`. */
  idParam?: string;
  /** Body field holding the reason, where the action requires one. */
  reasonField?: string;
}

const AUDITED = 'audited';

/**
 * Records an audit entry after the handler succeeds. Suits actions where the
 * route itself says what happened. When the entry needs `before` and `after`
 * values, call `AuditService.record()` from the service instead.
 */
export const Audited = (options: AuditedOptions) =>
  SetMetadata(AUDITED, options);

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const options = this.reflector.get<AuditedOptions | undefined>(
      AUDITED,
      context.getHandler(),
    );
    if (!options) return next.handle();

    const request = context.switchToHttp().getRequest<Request>();
    return next.handle().pipe(
      mergeMap(async (result: unknown) => {
        const entityId = request.params[options.idParam ?? 'id'];
        const reason: unknown = options.reasonField
          ? (request.body as Record<string, unknown> | undefined)?.[
              options.reasonField
            ]
          : undefined;
        await this.audit.record({
          action: options.action,
          entityType: options.entityType,
          entityId: typeof entityId === 'string' ? entityId : 'unknown',
          reason: typeof reason === 'string' ? reason : undefined,
        });
        return result;
      }),
    );
  }
}

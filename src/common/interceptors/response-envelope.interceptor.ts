import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { map, Observable } from 'rxjs';
import { Paginated } from '../dto/paginated.js';

export interface SuccessBody<T> {
  data: T;
  meta: {
    requestId: string | null;
    page?: number;
    pageSize?: number;
    total?: number;
  };
}

/** Wraps every successful response in the `{ data, meta }` envelope. */
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<SuccessBody<unknown>> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { id?: string }>();
    const requestId = request.id ?? null;

    return next.handle().pipe(
      map((result: unknown) => {
        if (result instanceof Paginated) {
          return {
            data: result.items,
            meta: {
              requestId,
              page: result.page,
              pageSize: result.pageSize,
              total: result.total,
            },
          };
        }
        return { data: result ?? null, meta: { requestId } };
      }),
    );
  }
}

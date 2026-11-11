import { AsyncLocalStorage } from 'node:async_hooks';
import type { Role } from '../../generated/prisma/enums.js';

/** Facts about the request in flight, readable anywhere below the middleware. */
export interface RequestContext {
  requestId: string;
  ipAddress: string | null;
  /** Filled in by JwtAuthGuard once the caller is known. */
  actor?: { id: string; role: Role };
}

const storage = new AsyncLocalStorage<RequestContext>();

export const requestContext = {
  run<T>(context: RequestContext, callback: () => T): T {
    return storage.run(context, callback);
  },
  get(): RequestContext | undefined {
    return storage.getStore();
  },
};

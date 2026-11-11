import type { AuthUser } from '../modules/auth/auth-user.js';

declare global {
  namespace Express {
    interface Request {
      /** Set by the request ID middleware. */
      id?: string;
      /** Set by JwtAuthGuard on authenticated requests. */
      user?: AuthUser;
    }
  }
}

export {};

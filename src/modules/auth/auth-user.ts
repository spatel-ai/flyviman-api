import type { Role } from '../../generated/prisma/enums.js';

/** The authenticated caller, attached to the request by JwtAuthGuard. */
export interface AuthUser {
  id: string;
  role: Role;
  /** Identifies the sign-in this request belongs to (Session.familyId). */
  sessionFamilyId: string;
}

import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { Role } from '../../generated/prisma/enums.js';

/**
 * What an operator's staff member may do (D-049). Operator administrators
 * hold every capability on every aircraft. Later milestones add capabilities
 * here (empty legs in M7, booking requests in M8).
 */
export const CAPABILITIES = ['MANAGE_AIRCRAFT', 'MANAGE_AVAILABILITY'] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** The shape of `OperatorMember.permissions` for a staff member. */
export interface StaffPermissions {
  capabilities: Capability[];
  /** Every aircraft of the operator, including ones added later. */
  allAircraft: boolean;
  /** Assigned aircraft, used when `allAircraft` is false. */
  aircraftIds: string[];
}

export const NO_PERMISSIONS: StaffPermissions = {
  capabilities: [],
  allAircraft: false,
  aircraftIds: [],
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reads stored permissions. Anything malformed or unknown grants nothing:
 * an unknown capability is dropped, a non-boolean `allAircraft` is false, and
 * an id that is not a UUID is ignored (fail closed).
 */
export function parsePermissions(raw: unknown): StaffPermissions {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return NO_PERMISSIONS;
  }
  const source = raw as Record<string, unknown>;
  const capabilities = Array.isArray(source.capabilities)
    ? CAPABILITIES.filter((capability) =>
        (source.capabilities as unknown[]).includes(capability),
      )
    : [];
  const aircraftIds = Array.isArray(source.aircraftIds)
    ? [
        ...new Set(
          (source.aircraftIds as unknown[]).filter(
            (id): id is string => typeof id === 'string' && UUID.test(id),
          ),
        ),
      ]
    : [];
  return {
    capabilities,
    allAircraft: source.allAircraft === true,
    aircraftIds,
  };
}

/** What the caller may do inside their operator, read on every request. */
export interface OperatorAccess {
  operatorId: string;
  role: Role;
  isAdmin: boolean;
  capabilities: Capability[];
  /** Aircraft in reach: every one of the operator's, or these ids. */
  aircraft: 'ALL' | string[];
}

export function adminAccess(operatorId: string): OperatorAccess {
  return {
    operatorId,
    role: Role.OPERATOR_ADMIN,
    isAdmin: true,
    capabilities: [...CAPABILITIES],
    aircraft: 'ALL',
  };
}

export function staffAccess(
  operatorId: string,
  permissions: StaffPermissions,
): OperatorAccess {
  return {
    operatorId,
    role: Role.OPERATOR_STAFF,
    isAdmin: false,
    capabilities: permissions.capabilities,
    aircraft: permissions.allAircraft ? 'ALL' : permissions.aircraftIds,
  };
}

/** Whether the caller holds at least one of the capabilities. */
export function can(
  access: OperatorAccess,
  ...capabilities: Capability[]
): boolean {
  return capabilities.some((capability) =>
    access.capabilities.includes(capability),
  );
}

/** Whether the aircraft is within the caller's reach. */
export function inScope(access: OperatorAccess, aircraftId: string): boolean {
  return access.aircraft === 'ALL' || access.aircraft.includes(aircraftId);
}

/** Restricts an aircraft query to the caller's operator and reach. */
export function aircraftWhere(
  access: OperatorAccess,
): Prisma.AircraftWhereInput {
  return access.aircraft === 'ALL'
    ? { operatorId: access.operatorId }
    : { operatorId: access.operatorId, id: { in: access.aircraft } };
}

/** 403 unless the caller holds at least one of the capabilities. */
export function assertCan(
  access: OperatorAccess,
  ...capabilities: Capability[]
): void {
  if (!can(access, ...capabilities)) {
    throw new AppException(
      'FORBIDDEN',
      'You do not have permission to do this.',
      HttpStatus.FORBIDDEN,
    );
  }
}

/** 403 unless the caller is an operator administrator. */
export function assertAdmin(access: OperatorAccess): void {
  if (!access.isAdmin) {
    throw new AppException(
      'FORBIDDEN',
      'Only an operator administrator can do this.',
      HttpStatus.FORBIDDEN,
    );
  }
}

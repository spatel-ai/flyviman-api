import { AircraftListingStatus, Role } from '../../generated/prisma/enums.js';

export type AircraftAction =
  'submit' | 'returnToReview' | 'approve' | 'reject' | 'suspend' | 'reinstate';

interface Transition {
  from: AircraftListingStatus[];
  to: AircraftListingStatus;
  roles: Role[];
  reasonRequired: boolean;
}

const REVIEWERS = [Role.OPS, Role.SUPER_ADMIN];

/** The aircraft listing state machine from docs/architecture/state-machines.md. */
export const AIRCRAFT_TRANSITIONS: Record<AircraftAction, Transition> = {
  submit: {
    from: [AircraftListingStatus.DRAFT, AircraftListingStatus.REJECTED],
    to: AircraftListingStatus.PENDING_REVIEW,
    roles: [Role.OPERATOR_ADMIN],
    reasonRequired: false,
  },
  /** A material edit, or a document change, on an approved listing. */
  returnToReview: {
    from: [AircraftListingStatus.APPROVED],
    to: AircraftListingStatus.PENDING_REVIEW,
    roles: [Role.OPERATOR_ADMIN],
    reasonRequired: false,
  },
  approve: {
    from: [AircraftListingStatus.PENDING_REVIEW],
    to: AircraftListingStatus.APPROVED,
    roles: REVIEWERS,
    reasonRequired: false,
  },
  reject: {
    from: [AircraftListingStatus.PENDING_REVIEW],
    to: AircraftListingStatus.REJECTED,
    roles: REVIEWERS,
    reasonRequired: true,
  },
  suspend: {
    from: [AircraftListingStatus.APPROVED],
    to: AircraftListingStatus.SUSPENDED,
    roles: REVIEWERS,
    reasonRequired: true,
  },
  reinstate: {
    from: [AircraftListingStatus.SUSPENDED],
    to: AircraftListingStatus.APPROVED,
    roles: REVIEWERS,
    reasonRequired: false,
  },
};

export type TransitionRefusal = 'role' | 'state' | 'reason';

/** The status the action leads to, or why it is not allowed. */
export function nextAircraftStatus(
  action: AircraftAction,
  current: AircraftListingStatus,
  role: Role,
  reason?: string,
): { to: AircraftListingStatus } | { refused: TransitionRefusal } {
  const transition = AIRCRAFT_TRANSITIONS[action];
  if (!transition.roles.includes(role)) return { refused: 'role' };
  if (!transition.from.includes(current)) return { refused: 'state' };
  if (transition.reasonRequired && !reason?.trim())
    return { refused: 'reason' };
  return { to: transition.to };
}

/**
 * Fields that, when changed on an APPROVED aircraft, send it back to
 * PENDING_REVIEW. Photos and specifications (descriptions) are not listed.
 */
export const MATERIAL_FIELDS = [
  'registration',
  'manufacturer',
  'model',
  'category',
  'wingType',
  'passengerCapacity',
  'baggageCapacityKg',
  'rangeKm',
  'cruiseSpeedKmh',
  'homeBaseId',
  'pricingModel',
  'medicalEquipment',
] as const;

export type MaterialField = (typeof MATERIAL_FIELDS)[number];

export function touchesMaterial(
  changes: Partial<Record<MaterialField, unknown>>,
): boolean {
  return MATERIAL_FIELDS.some((field) => changes[field] !== undefined);
}

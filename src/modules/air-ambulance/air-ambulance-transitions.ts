import { AirAmbulanceStatus, Role } from '../../generated/prisma/enums.js';

/**
 * The air ambulance request status machine, exactly as
 * docs/architecture/state-machines.md (Air ambulance request) draws it.
 * Pure, so the whole table is unit tested. `AirAmbulanceWorkflowService`
 * applies it, writes the timeline entry and the audit record, and updates
 * the row only if its status is still `from`.
 *
 * Rule 7: no system, payment or customer path leads to CONFIRMED. Only
 * operations (`OPS`, `SUPER_ADMIN`) confirm, and only with the feasibility
 * checklist complete; the database refuses a CONFIRMED timeline entry
 * without such an actor (`AirAmbulanceRequestEvent_confirmed_by_person`).
 */

/** Who moves a request. There is deliberately no system actor. */
export type AirAmbulanceActorKind = 'CUSTOMER' | 'OPERATIONS';

/** The actor a signed-in role acts as; `null` for roles that never do. */
export function actorKindFor(role: Role): AirAmbulanceActorKind | null {
  switch (role) {
    case Role.CUSTOMER:
      return 'CUSTOMER';
    case Role.OPS:
    case Role.SUPER_ADMIN:
      return 'OPERATIONS';
    default:
      return null;
  }
}

/**
 * The feasibility checklist operations record before confirming: the items
 * of state-machines.md (operator acceptance, medical mission suitability,
 * equipment, crew, landing permissions, other clearances) and of the W4-5
 * brief (aircraft, medical team, weather). Booleans only: the timeline is
 * append-only and shown to staff without medical access, so it never holds
 * free text (rule 8).
 */
export const FEASIBILITY_ITEMS = [
  'operatorAcceptance',
  'aircraft',
  'crew',
  'medicalTeam',
  'medicalSuitability',
  'equipment',
  'landingPermissions',
  'clearances',
  'weather',
] as const;

export type FeasibilityItem = (typeof FEASIBILITY_ITEMS)[number];
export type FeasibilityChecklist = Record<FeasibilityItem, boolean>;

/** The items not yet checked; all of them when nothing was recorded. */
export function missingFeasibility(
  checklist: FeasibilityChecklist | null,
): FeasibilityItem[] {
  return FEASIBILITY_ITEMS.filter((item) => checklist?.[item] !== true);
}

/**
 * A checklist read back from a timeline payload (jsonb). Anything that is
 * not a recorded checklist reads as nothing recorded.
 */
export function parseChecklist(payload: unknown): FeasibilityChecklist | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const checklist = (payload as { checklist?: unknown }).checklist;
  if (typeof checklist !== 'object' || checklist === null) return null;
  const result = {} as FeasibilityChecklist;
  for (const item of FEASIBILITY_ITEMS) {
    const value: unknown = Object.hasOwn(checklist, item)
      ? (checklist as Record<string, unknown>)[item]
      : false;
    result[item] = value === true;
  }
  return result;
}

export interface TransitionContext {
  /** Every feasibility item recorded as checked. */
  feasibilityComplete: boolean;
}

export type TransitionCheck =
  { allowed: true } | { allowed: false; reason: string };

const S = AirAmbulanceStatus;

/** Closed: nothing moves any more. */
export const CLOSED: ReadonlySet<AirAmbulanceStatus> = new Set([
  S.COMPLETED,
  S.DECLINED,
  S.CANCELLED,
]);

interface Edge {
  from: AirAmbulanceStatus;
  to: AirAmbulanceStatus;
  by: readonly AirAmbulanceActorKind[];
  unless?: (context: TransitionContext) => string | null;
}

/** Every forward move. DECLINED and CANCELLED are handled below. */
const EDGES: readonly Edge[] = [
  { from: S.SUBMITTED, to: S.ASSIGNED, by: ['OPERATIONS'] },
  { from: S.ASSIGNED, to: S.SOURCING, by: ['OPERATIONS'] },
  { from: S.SOURCING, to: S.FEASIBILITY_CHECK, by: ['OPERATIONS'] },
  { from: S.FEASIBILITY_CHECK, to: S.QUOTED, by: ['OPERATIONS'] },
  { from: S.QUOTED, to: S.ACCEPTED, by: ['CUSTOMER'] },
  {
    from: S.ACCEPTED,
    to: S.CONFIRMED,
    by: ['OPERATIONS'],
    unless: (c) =>
      c.feasibilityComplete
        ? null
        : 'the feasibility checklist is not complete',
  },
  { from: S.CONFIRMED, to: S.COMPLETED, by: ['OPERATIONS'] },
];

/**
 * Whether `actor` may move a request from `from` to `to`. DECLINED and
 * CANCELLED are reachable from any status before COMPLETED: operations may
 * decline (no feasible option) or cancel; the customer may withdraw
 * (CANCELLED) at any point and decline only a quotation.
 */
export function checkTransition(
  from: AirAmbulanceStatus,
  to: AirAmbulanceStatus,
  actor: AirAmbulanceActorKind,
  context: TransitionContext,
): TransitionCheck {
  if (from === to) return { allowed: false, reason: 'the status is unchanged' };
  if (CLOSED.has(from)) {
    return { allowed: false, reason: `a ${from} request is closed` };
  }
  if (to === S.CANCELLED) return { allowed: true };
  if (to === S.DECLINED) {
    return actor === 'OPERATIONS' || from === S.QUOTED
      ? { allowed: true }
      : { allowed: false, reason: 'only a quotation can be declined' };
  }
  const edge = EDGES.find((entry) => entry.from === from && entry.to === to);
  if (!edge) return { allowed: false, reason: `${from} cannot become ${to}` };
  if (!edge.by.includes(actor)) {
    return { allowed: false, reason: `${actor} cannot move ${from} to ${to}` };
  }
  const blocker = edge.unless?.(context) ?? null;
  return blocker ? { allowed: false, reason: blocker } : { allowed: true };
}

/** The timestamps entering `to` sets. */
export function statusTimestamps(
  to: AirAmbulanceStatus,
  now: Date,
): { confirmedAt?: Date; completedAt?: Date; closedAt?: Date } {
  if (to === S.CONFIRMED) return { confirmedAt: now };
  if (to === S.COMPLETED) return { completedAt: now };
  if (to === S.DECLINED || to === S.CANCELLED) return { closedAt: now };
  return {};
}

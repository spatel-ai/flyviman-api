import { OperatorStatus, Role } from '../../generated/prisma/enums.js';

export type OperatorAction =
  'submit' | 'approve' | 'reject' | 'suspend' | 'reinstate';

interface Transition {
  from: OperatorStatus[];
  to: OperatorStatus;
  roles: Role[];
  reasonRequired: boolean;
}

const REVIEWERS = [Role.OPS, Role.SUPER_ADMIN];

/** The operator state machine from docs/architecture/state-machines.md. */
export const OPERATOR_TRANSITIONS: Record<OperatorAction, Transition> = {
  submit: {
    from: [OperatorStatus.DRAFT, OperatorStatus.REJECTED],
    to: OperatorStatus.PENDING_REVIEW,
    roles: [Role.OPERATOR_ADMIN],
    reasonRequired: false,
  },
  approve: {
    from: [OperatorStatus.PENDING_REVIEW],
    to: OperatorStatus.APPROVED,
    roles: REVIEWERS,
    reasonRequired: false,
  },
  reject: {
    from: [OperatorStatus.PENDING_REVIEW],
    to: OperatorStatus.REJECTED,
    roles: REVIEWERS,
    reasonRequired: true,
  },
  suspend: {
    from: [OperatorStatus.APPROVED],
    to: OperatorStatus.SUSPENDED,
    roles: REVIEWERS,
    reasonRequired: true,
  },
  reinstate: {
    from: [OperatorStatus.SUSPENDED],
    to: OperatorStatus.APPROVED,
    roles: REVIEWERS,
    reasonRequired: false,
  },
};

export type TransitionRefusal = 'role' | 'state' | 'reason';

/** The status the action leads to, or why it is not allowed. */
export function nextOperatorStatus(
  action: OperatorAction,
  current: OperatorStatus,
  role: Role,
  reason?: string,
): { to: OperatorStatus } | { refused: TransitionRefusal } {
  const transition = OPERATOR_TRANSITIONS[action];
  if (!transition.roles.includes(role)) return { refused: 'role' };
  if (!transition.from.includes(current)) return { refused: 'state' };
  if (transition.reasonRequired && !reason?.trim())
    return { refused: 'reason' };
  return { to: transition.to };
}

import { OperatorStatus, Role } from '../../generated/prisma/enums.js';
import {
  nextOperatorStatus,
  OPERATOR_TRANSITIONS,
  OperatorAction,
} from './operator-transitions.js';

const S = OperatorStatus;

describe('operator state machine', () => {
  it.each<[OperatorAction, OperatorStatus, Role, OperatorStatus]>([
    ['submit', S.DRAFT, Role.OPERATOR_ADMIN, S.PENDING_REVIEW],
    ['submit', S.REJECTED, Role.OPERATOR_ADMIN, S.PENDING_REVIEW],
    ['approve', S.PENDING_REVIEW, Role.OPS, S.APPROVED],
    ['approve', S.PENDING_REVIEW, Role.SUPER_ADMIN, S.APPROVED],
    ['reject', S.PENDING_REVIEW, Role.OPS, S.REJECTED],
    ['suspend', S.APPROVED, Role.OPS, S.SUSPENDED],
    ['reinstate', S.SUSPENDED, Role.SUPER_ADMIN, S.APPROVED],
  ])('%s from %s by %s leads to %s', (action, from, role, to) => {
    expect(nextOperatorStatus(action, from, role, 'because')).toEqual({ to });
  });

  it('allows exactly the documented transitions and no others', () => {
    const allowed = new Set<string>();
    for (const action of Object.keys(
      OPERATOR_TRANSITIONS,
    ) as OperatorAction[]) {
      for (const from of Object.values(S)) {
        const role = OPERATOR_TRANSITIONS[action].roles[0];
        const result = nextOperatorStatus(action, from, role, 'because');
        if ('to' in result) allowed.add(`${from}>${result.to}`);
      }
    }
    expect([...allowed].sort()).toEqual(
      [
        'DRAFT>PENDING_REVIEW',
        'REJECTED>PENDING_REVIEW',
        'PENDING_REVIEW>APPROVED',
        'PENDING_REVIEW>REJECTED',
        'APPROVED>SUSPENDED',
        'SUSPENDED>APPROVED',
      ].sort(),
    );
  });

  it.each<[OperatorAction, OperatorStatus]>([
    ['approve', S.DRAFT],
    ['approve', S.REJECTED],
    ['approve', S.APPROVED],
    ['submit', S.PENDING_REVIEW],
    ['submit', S.APPROVED],
    ['suspend', S.PENDING_REVIEW],
    ['reinstate', S.APPROVED],
    ['reject', S.APPROVED],
  ])('refuses %s from %s', (action, from) => {
    const role = OPERATOR_TRANSITIONS[action].roles[0];
    expect(nextOperatorStatus(action, from, role, 'because')).toEqual({
      refused: 'state',
    });
  });

  it('refuses the wrong role', () => {
    expect(
      nextOperatorStatus('approve', S.PENDING_REVIEW, Role.OPERATOR_ADMIN),
    ).toEqual({
      refused: 'role',
    });
    expect(
      nextOperatorStatus('approve', S.PENDING_REVIEW, Role.FINANCE_ADMIN),
    ).toEqual({
      refused: 'role',
    });
    expect(nextOperatorStatus('submit', S.DRAFT, Role.OPS)).toEqual({
      refused: 'role',
    });
  });

  it('requires a reason to reject or suspend', () => {
    expect(nextOperatorStatus('reject', S.PENDING_REVIEW, Role.OPS)).toEqual({
      refused: 'reason',
    });
    expect(nextOperatorStatus('suspend', S.APPROVED, Role.OPS, '   ')).toEqual({
      refused: 'reason',
    });
  });
});

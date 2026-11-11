import { AircraftListingStatus, Role } from '../../generated/prisma/enums.js';
import {
  AIRCRAFT_TRANSITIONS,
  nextAircraftStatus,
  touchesMaterial,
  type AircraftAction,
} from './aircraft-transitions.js';

const S = AircraftListingStatus;

describe('aircraft listing state machine', () => {
  it.each<[AircraftAction, AircraftListingStatus, Role, AircraftListingStatus]>(
    [
      ['submit', S.DRAFT, Role.OPERATOR_ADMIN, S.PENDING_REVIEW],
      ['submit', S.REJECTED, Role.OPERATOR_ADMIN, S.PENDING_REVIEW],
      ['returnToReview', S.APPROVED, Role.OPERATOR_ADMIN, S.PENDING_REVIEW],
      ['approve', S.PENDING_REVIEW, Role.OPS, S.APPROVED],
      ['reject', S.PENDING_REVIEW, Role.SUPER_ADMIN, S.REJECTED],
      ['suspend', S.APPROVED, Role.OPS, S.SUSPENDED],
      ['reinstate', S.SUSPENDED, Role.SUPER_ADMIN, S.APPROVED],
    ],
  )('%s from %s by %s leads to %s', (action, from, role, to) => {
    expect(nextAircraftStatus(action, from, role, 'because')).toEqual({ to });
  });

  it('allows exactly the documented transitions and no others', () => {
    const allowed = new Set<string>();
    for (const action of Object.keys(
      AIRCRAFT_TRANSITIONS,
    ) as AircraftAction[]) {
      for (const from of Object.values(S)) {
        const role = AIRCRAFT_TRANSITIONS[action].roles[0];
        const result = nextAircraftStatus(action, from, role, 'because');
        if ('to' in result) allowed.add(`${from}>${result.to}`);
      }
    }
    expect([...allowed].sort()).toEqual(
      [
        'DRAFT>PENDING_REVIEW',
        'REJECTED>PENDING_REVIEW',
        'APPROVED>PENDING_REVIEW',
        'PENDING_REVIEW>APPROVED',
        'PENDING_REVIEW>REJECTED',
        'APPROVED>SUSPENDED',
        'SUSPENDED>APPROVED',
      ].sort(),
    );
  });

  it('refuses a reject without a reason and a staff submit', () => {
    expect(nextAircraftStatus('reject', S.PENDING_REVIEW, Role.OPS)).toEqual({
      refused: 'reason',
    });
    expect(nextAircraftStatus('submit', S.DRAFT, Role.OPERATOR_STAFF)).toEqual({
      refused: 'role',
    });
  });
});

describe('touchesMaterial', () => {
  it('treats registration and capacity as material, specifications as not', () => {
    expect(touchesMaterial({ registration: 'VT-ABC' })).toBe(true);
    expect(touchesMaterial({ passengerCapacity: 8 })).toBe(true);
    expect(touchesMaterial({})).toBe(false);
  });
});

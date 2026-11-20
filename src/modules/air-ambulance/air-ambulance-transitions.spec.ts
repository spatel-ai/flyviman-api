import { describe, expect, it } from 'vitest';
import { AirAmbulanceStatus, Role } from '../../generated/prisma/enums.js';
import {
  actorKindFor,
  checkTransition,
  FEASIBILITY_ITEMS,
  missingFeasibility,
  parseChecklist,
  statusTimestamps,
} from './air-ambulance-transitions.js';

const S = AirAmbulanceStatus;
const ALL = Object.values(S);
const complete = { feasibilityComplete: true };
const incomplete = { feasibilityComplete: false };

describe('air ambulance transitions', () => {
  it('follows the documented chain for operations and the customer', () => {
    const chain: [
      AirAmbulanceStatus,
      AirAmbulanceStatus,
      'CUSTOMER' | 'OPERATIONS',
    ][] = [
      [S.SUBMITTED, S.ASSIGNED, 'OPERATIONS'],
      [S.ASSIGNED, S.SOURCING, 'OPERATIONS'],
      [S.SOURCING, S.FEASIBILITY_CHECK, 'OPERATIONS'],
      [S.FEASIBILITY_CHECK, S.QUOTED, 'OPERATIONS'],
      [S.QUOTED, S.ACCEPTED, 'CUSTOMER'],
      [S.ACCEPTED, S.CONFIRMED, 'OPERATIONS'],
      [S.CONFIRMED, S.COMPLETED, 'OPERATIONS'],
    ];
    for (const [from, to, by] of chain) {
      expect(checkTransition(from, to, by, complete), `${from}->${to}`).toEqual(
        {
          allowed: true,
        },
      );
    }
  });

  it('never lets the customer reach CONFIRMED, from any status (rule 7)', () => {
    for (const from of ALL) {
      expect(
        checkTransition(from, S.CONFIRMED, 'CUSTOMER', complete).allowed,
      ).toBe(false);
    }
  });

  it('refuses CONFIRMED without the whole feasibility checklist', () => {
    expect(
      checkTransition(S.ACCEPTED, S.CONFIRMED, 'OPERATIONS', incomplete),
    ).toEqual({
      allowed: false,
      reason: 'the feasibility checklist is not complete',
    });
  });

  it('reaches CONFIRMED only from ACCEPTED', () => {
    for (const from of ALL.filter((s) => s !== S.ACCEPTED)) {
      expect(
        checkTransition(from, S.CONFIRMED, 'OPERATIONS', complete).allowed,
      ).toBe(false);
    }
  });

  it('lets anyone cancel before COMPLETED, and nothing moves once closed', () => {
    for (const from of ALL) {
      const closed = [S.COMPLETED, S.DECLINED, S.CANCELLED].includes(from);
      for (const by of ['CUSTOMER', 'OPERATIONS'] as const) {
        expect(
          checkTransition(from, S.CANCELLED, by, complete).allowed,
          `${by} ${from}`,
        ).toBe(!closed && from !== S.CANCELLED);
      }
    }
    expect(
      checkTransition(S.DECLINED, S.SOURCING, 'OPERATIONS', complete).allowed,
    ).toBe(false);
  });

  it('lets the customer decline only a quotation; operations any open request', () => {
    expect(
      checkTransition(S.QUOTED, S.DECLINED, 'CUSTOMER', complete).allowed,
    ).toBe(true);
    expect(
      checkTransition(S.SOURCING, S.DECLINED, 'CUSTOMER', complete).allowed,
    ).toBe(false);
    expect(
      checkTransition(S.SOURCING, S.DECLINED, 'OPERATIONS', complete).allowed,
    ).toBe(true);
  });

  it('refuses skipped steps and moves by the wrong actor', () => {
    expect(
      checkTransition(S.SUBMITTED, S.SOURCING, 'OPERATIONS', complete).allowed,
    ).toBe(false);
    expect(
      checkTransition(S.QUOTED, S.ACCEPTED, 'OPERATIONS', complete).allowed,
    ).toBe(false);
    expect(
      checkTransition(S.ASSIGNED, S.SOURCING, 'CUSTOMER', complete).allowed,
    ).toBe(false);
  });

  it('acts only for customers, operations and super administrators', () => {
    expect(actorKindFor(Role.CUSTOMER)).toBe('CUSTOMER');
    expect(actorKindFor(Role.OPS)).toBe('OPERATIONS');
    expect(actorKindFor(Role.SUPER_ADMIN)).toBe('OPERATIONS');
    for (const role of [
      Role.FINANCE_ADMIN,
      Role.OPERATOR_ADMIN,
      Role.OPERATOR_STAFF,
    ]) {
      expect(actorKindFor(role)).toBeNull();
    }
  });

  it('sets the time of confirmation, completion and closing', () => {
    const now = new Date('2026-11-20T10:00:00Z');
    expect(statusTimestamps(S.CONFIRMED, now)).toEqual({ confirmedAt: now });
    expect(statusTimestamps(S.COMPLETED, now)).toEqual({ completedAt: now });
    expect(statusTimestamps(S.DECLINED, now)).toEqual({ closedAt: now });
    expect(statusTimestamps(S.CANCELLED, now)).toEqual({ closedAt: now });
    expect(statusTimestamps(S.SOURCING, now)).toEqual({});
  });
});

describe('feasibility checklist', () => {
  it('reads nothing recorded as every item missing', () => {
    expect(missingFeasibility(null)).toEqual([...FEASIBILITY_ITEMS]);
    expect(parseChecklist(null)).toBeNull();
    expect(parseChecklist({ checklist: 'yes' })).toBeNull();
  });

  it('counts only a literal true as checked', () => {
    const checklist = parseChecklist({
      checklist: {
        ...Object.fromEntries(FEASIBILITY_ITEMS.map((i) => [i, true])),
        weather: 'true',
      },
    });
    expect(missingFeasibility(checklist)).toEqual(['weather']);
  });

  it('is complete when every item is true', () => {
    const checklist = parseChecklist({
      checklist: Object.fromEntries(FEASIBILITY_ITEMS.map((i) => [i, true])),
    });
    expect(missingFeasibility(checklist)).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { AppException } from '../../common/errors/app.exception.js';
import {
  adminAccess,
  aircraftWhere,
  assertAdmin,
  assertCan,
  can,
  inScope,
  NO_PERMISSIONS,
  parsePermissions,
  staffAccess,
} from './operator-access.js';

const A = '0b8f6a3e-6f2d-4b4a-9a1e-2f1d3c4b5a61';
const B = '7c1e2d3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';

describe('parsePermissions', () => {
  it('reads a well-formed value', () => {
    expect(
      parsePermissions({
        capabilities: ['MANAGE_AVAILABILITY'],
        allAircraft: false,
        aircraftIds: [A],
      }),
    ).toEqual({
      capabilities: ['MANAGE_AVAILABILITY'],
      allAircraft: false,
      aircraftIds: [A],
    });
  });

  it('grants nothing for missing or malformed data', () => {
    for (const raw of [null, undefined, 'all', 42, [], {}]) {
      expect(parsePermissions(raw)).toEqual(NO_PERMISSIONS);
    }
  });

  it('drops unknown capabilities, bad ids and duplicates', () => {
    expect(
      parsePermissions({
        capabilities: ['MANAGE_AIRCRAFT', 'ADMIN', 7],
        aircraftIds: [A, A, 'not-an-id', 3, B],
      }),
    ).toEqual({
      capabilities: ['MANAGE_AIRCRAFT'],
      allAircraft: false,
      aircraftIds: [A, B],
    });
  });

  it('treats anything but true as not all aircraft', () => {
    expect(parsePermissions({ allAircraft: 'true' }).allAircraft).toBe(false);
    expect(parsePermissions({ allAircraft: 1 }).allAircraft).toBe(false);
    expect(parsePermissions({ allAircraft: true }).allAircraft).toBe(true);
  });
});

describe('access', () => {
  const op = 'operator-1';

  it('gives an administrator every capability on every aircraft', () => {
    const access = adminAccess(op);
    expect(can(access, 'MANAGE_AIRCRAFT')).toBe(true);
    expect(can(access, 'MANAGE_AVAILABILITY')).toBe(true);
    expect(inScope(access, B)).toBe(true);
    expect(aircraftWhere(access)).toEqual({ operatorId: op });
    expect(() => assertAdmin(access)).not.toThrow();
  });

  it('limits staff to their capabilities and aircraft', () => {
    const access = staffAccess(op, {
      capabilities: ['MANAGE_AVAILABILITY'],
      allAircraft: false,
      aircraftIds: [A],
    });
    expect(can(access, 'MANAGE_AIRCRAFT')).toBe(false);
    expect(can(access, 'MANAGE_AIRCRAFT', 'MANAGE_AVAILABILITY')).toBe(true);
    expect(inScope(access, A)).toBe(true);
    expect(inScope(access, B)).toBe(false);
    expect(aircraftWhere(access)).toEqual({
      operatorId: op,
      id: { in: [A] },
    });
    expect(() => assertCan(access, 'MANAGE_AIRCRAFT')).toThrow(AppException);
    expect(() => assertAdmin(access)).toThrow(AppException);
  });

  it('gives staff with all aircraft the whole fleet, but no extra capability', () => {
    const access = staffAccess(op, {
      capabilities: ['MANAGE_AIRCRAFT'],
      allAircraft: true,
      aircraftIds: [],
    });
    expect(inScope(access, B)).toBe(true);
    expect(aircraftWhere(access)).toEqual({ operatorId: op });
    expect(can(access, 'MANAGE_AVAILABILITY')).toBe(false);
  });

  it('gives staff with no assignment nothing', () => {
    const access = staffAccess(op, NO_PERMISSIONS);
    expect(inScope(access, A)).toBe(false);
    expect(aircraftWhere(access)).toEqual({ operatorId: op, id: { in: [] } });
  });
});

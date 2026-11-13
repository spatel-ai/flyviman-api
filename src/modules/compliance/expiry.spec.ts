import { describe, expect, it } from 'vitest';
import {
  alertThreshold,
  dateAfter,
  daysUntil,
  type ExpiryCandidate,
  expiringDocuments,
  indiaToday,
} from './expiry.js';

const doc = (
  overrides: Partial<ExpiryCandidate> & { expiresAt: Date | null },
): ExpiryCandidate => ({
  kind: 'AIRCRAFT',
  documentId: overrides.documentId ?? 'doc-1',
  type: 'INSURANCE',
  verificationStatus: 'VERIFIED',
  operatorId: 'op-1',
  operatorName: 'Skyline',
  aircraftId: 'ac-1',
  registration: 'VT-ABC',
  ...overrides,
});

describe('dates in India', () => {
  it('takes the calendar day in India, not UTC', () => {
    // 20:00 UTC on 13 Nov is 01:30 on 14 Nov in India.
    expect(indiaToday(new Date('2026-11-13T20:00:00Z'))).toBe('2026-11-14');
    expect(indiaToday(new Date('2026-11-13T10:00:00Z'))).toBe('2026-11-13');
  });

  it('counts whole days to the expiry date', () => {
    expect(daysUntil(new Date('2026-12-13T00:00:00Z'), '2026-11-13')).toBe(30);
    expect(daysUntil(new Date('2026-11-13T00:00:00Z'), '2026-11-13')).toBe(0);
    expect(daysUntil(new Date('2026-11-10T00:00:00Z'), '2026-11-13')).toBe(-3);
    expect(dateAfter('2026-11-13', 7).toISOString()).toBe(
      '2026-11-20T00:00:00.000Z',
    );
  });
});

describe('alertThreshold', () => {
  it('uses the nearest threshold reached', () => {
    expect(alertThreshold(31)).toBeNull();
    expect(alertThreshold(30)).toBe(30);
    expect(alertThreshold(8)).toBe(30);
    expect(alertThreshold(7)).toBe(7);
    expect(alertThreshold(1)).toBe(7);
    expect(alertThreshold(0)).toBe(0);
    expect(alertThreshold(-5)).toBe(0);
  });
});

describe('expiringDocuments', () => {
  const today = '2026-11-13';

  it('keeps documents within the window, soonest first, with days left', () => {
    const result = expiringDocuments(
      [
        doc({
          documentId: 'b',
          aircraftId: 'ac-2',
          expiresAt: dateAfter(today, 20),
        }),
        doc({ documentId: 'a', expiresAt: dateAfter(today, 3) }),
        doc({
          documentId: 'c',
          aircraftId: 'ac-3',
          expiresAt: dateAfter(today, 45),
        }),
      ],
      today,
      30,
    );
    expect(result.map((d) => [d.documentId, d.daysLeft])).toEqual([
      ['a', 3],
      ['b', 20],
    ]);
  });

  it('drops a copy replaced by a renewal or by one with no expiry', () => {
    const renewed = expiringDocuments(
      [
        doc({ documentId: 'old', expiresAt: dateAfter(today, 2) }),
        doc({ documentId: 'new', expiresAt: dateAfter(today, 365) }),
      ],
      today,
      30,
    );
    expect(renewed).toEqual([]);
    const open = expiringDocuments(
      [
        doc({ documentId: 'old', expiresAt: dateAfter(today, 2) }),
        doc({ documentId: 'open', expiresAt: null }),
      ],
      today,
      30,
    );
    expect(open).toEqual([]);
  });

  it('keeps types and owners apart', () => {
    const result = expiringDocuments(
      [
        doc({ documentId: 'ins', expiresAt: dateAfter(today, 2) }),
        doc({
          documentId: 'air',
          type: 'AIRWORTHINESS',
          expiresAt: dateAfter(today, 365),
        }),
        doc({
          documentId: 'op',
          kind: 'OPERATOR',
          aircraftId: null,
          registration: null,
          expiresAt: dateAfter(today, -1),
        }),
      ],
      today,
      30,
    );
    expect(result.map((d) => d.documentId)).toEqual(['op', 'ins']);
  });
});

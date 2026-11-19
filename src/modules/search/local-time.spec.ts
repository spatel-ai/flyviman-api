import { localIso, localToday } from './local-time.js';

describe('localIso', () => {
  it('shows an instant in India with its offset', () => {
    const value = localIso('2026-12-05T00:45:00.000Z', 'Asia/Kolkata');
    expect(value).toBe('2026-12-05T06:15:00+05:30');
    expect(Date.parse(value)).toBe(Date.parse('2026-12-05T00:45:00.000Z'));
  });

  it('handles negative offsets and UTC', () => {
    expect(localIso('2026-01-10T03:00:00Z', 'America/New_York')).toBe(
      '2026-01-09T22:00:00-05:00',
    );
    expect(localIso('2026-01-10T03:00:00Z', 'UTC')).toBe(
      '2026-01-10T03:00:00+00:00',
    );
  });
});

describe('localToday', () => {
  it('is the calendar date in the zone', () => {
    const now = new Date('2026-12-04T20:00:00Z');
    expect(localToday('Asia/Kolkata', now)).toBe('2026-12-05');
    expect(localToday('UTC', now)).toBe('2026-12-04');
  });
});

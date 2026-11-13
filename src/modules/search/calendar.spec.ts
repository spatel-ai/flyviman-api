import { describe, expect, it } from 'vitest';
import { calendarDepartures, monthInRange } from './calendar.js';

describe('calendarDepartures', () => {
  it('gives every day of the month at 10:00 India time', () => {
    const days = calendarDepartures(
      '2026-12',
      new Date('2026-11-01T00:00:00Z'),
      60,
    );
    expect(days).toHaveLength(31);
    expect(days[0]).toEqual({
      date: '2026-12-01',
      departureAt: new Date('2026-12-01T04:30:00.000Z'),
    });
    expect(days[30].date).toBe('2026-12-31');
  });

  it('leaves out days inside the minimum notice', () => {
    const days = calendarDepartures(
      '2026-12',
      new Date('2026-12-10T04:00:00Z'),
      60,
    );
    expect(days[0].date).toBe('2026-12-11');
  });

  it('knows short months and leap years', () => {
    const now = new Date('2027-01-01T00:00:00Z');
    expect(calendarDepartures('2027-02', now, 60)).toHaveLength(28);
    expect(calendarDepartures('2028-02', now, 60)).toHaveLength(29);
  });
});

describe('monthInRange', () => {
  const now = new Date('2026-11-30T20:00:00Z'); // already 1 December in India
  it('allows this month in India and the next twelve', () => {
    expect(monthInRange('2026-12', now, 12)).toBe(true);
    expect(monthInRange('2027-12', now, 12)).toBe(true);
  });
  it('refuses past months and months too far ahead', () => {
    expect(monthInRange('2026-11', now, 12)).toBe(false);
    expect(monthInRange('2028-01', now, 12)).toBe(false);
  });
});

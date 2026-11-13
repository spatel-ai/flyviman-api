import { describe, expect, it } from 'vitest';
import { calendarDepartures } from './calendar.js';

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

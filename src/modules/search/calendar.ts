/** Fare calendar departures are priced at this India time. */
export const CALENDAR_DEPARTURE = { hour: 10, minute: 0 };
const INDIA_OFFSET_MINUTES = 330;

/**
 * Each day of `month` (YYYY-MM) with its 10:00 India-time departure,
 * leaving out days whose departure is within the minimum notice.
 */
export function calendarDepartures(
  month: string,
  now: Date,
  minNoticeMinutes: number,
): { date: string; departureAt: Date }[] {
  const [year, monthIndex] = month.split('-').map(Number);
  const days = new Date(Date.UTC(year, monthIndex, 0)).getUTCDate();
  const earliest = now.getTime() + minNoticeMinutes * 60_000;
  const result: { date: string; departureAt: Date }[] = [];
  for (let day = 1; day <= days; day += 1) {
    const departureAt = new Date(
      Date.UTC(
        year,
        monthIndex - 1,
        day,
        CALENDAR_DEPARTURE.hour,
        CALENDAR_DEPARTURE.minute - INDIA_OFFSET_MINUTES,
      ),
    );
    if (departureAt.getTime() < earliest) continue;
    const date = `${month}-${String(day).padStart(2, '0')}`;
    result.push({ date, departureAt });
  }
  return result;
}

/** Whether `month` (YYYY-MM) is this month or within `ahead` months of it, in India. */
export function monthInRange(month: string, now: Date, ahead: number): boolean {
  const india = new Date(now.getTime() + INDIA_OFFSET_MINUTES * 60_000);
  const current = india.getUTCFullYear() * 12 + india.getUTCMonth();
  const [year, monthNumber] = month.split('-').map(Number);
  const asked = year * 12 + (monthNumber - 1);
  return asked >= current && asked <= current + ahead;
}

/**
 * An instant as local time in an IANA zone with its offset, for example
 * `2026-12-05T06:15:00+05:30`: the same instant as the UTC form, readable
 * without a time zone library.
 */
export function localIso(instant: string | Date, timeZone: string): string {
  const date = new Date(instant);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const local = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
  const offsetMinutes = Math.round(
    (Date.parse(`${local}Z`) - Math.floor(date.getTime() / 1000) * 1000) /
      60000,
  );
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${local}${sign}${hh}:${mm}`;
}

/** Today's date in an IANA zone, `YYYY-MM-DD`. */
export function localToday(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

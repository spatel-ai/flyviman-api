/**
 * Calendar days in India, the one time zone at launch (open decision 12).
 * Document expiry is a calendar date, so "expired" and "days left" are
 * counted from today in India everywhere: the expiry job, the admin list,
 * the aircraft's search blockers and the web (D-072).
 */

const DAY_MS = 86_400_000;

/** Today's date in India, `YYYY-MM-DD`. */
export function indiaToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** A calendar date plus days, as the UTC-midnight Date a date column holds. */
export function dateAfter(today: string, days: number): Date {
  return new Date(Date.parse(`${today}T00:00:00Z`) + days * DAY_MS);
}

/** Today in India as a date-column value, for comparing with `expiresAt`. */
export function indiaTodayAsDate(now = new Date()): Date {
  return dateAfter(indiaToday(now), 0);
}

/** A moment as people read it in India: `24 Nov 2026, 12:10 pm IST`. */
export function indiaDateTime(moment: Date): string {
  const text = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(moment);
  return `${text.replace(' at ', ', ').replace(/\b(am|pm)\b/i, (m) => m.toLowerCase())} IST`;
}

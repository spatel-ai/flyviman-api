/**
 * Document expiry rules (M3 step 8, D-048, D-072). Pure, so the job and the
 * admin page share them and they are tested with a fixed clock.
 */

/** Alerts go out at 30 days, 7 days and on the day (D-048). */
export const ALERT_THRESHOLDS = [30, 7, 0] as const;
export type AlertThreshold = (typeof ALERT_THRESHOLDS)[number];

export type ExpiryKind = 'OPERATOR' | 'AIRCRAFT';

/** A document that may need an alert, as the owning module reports it. */
export interface ExpiryCandidate {
  kind: ExpiryKind;
  documentId: string;
  type: string;
  /** Calendar date, stored as UTC midnight. */
  expiresAt: Date | null;
  verificationStatus: string;
  operatorId: string;
  operatorName: string;
  aircraftId: string | null;
  registration: string | null;
}

export interface ExpiringDocument extends ExpiryCandidate {
  expiresAt: Date;
  /** Whole days from today (India) to the expiry date; negative once past. */
  daysLeft: number;
}

const DAY_MS = 86_400_000;

export { dateAfter, indiaToday } from '../../common/india-date.js';

export function daysUntil(expiresAt: Date, today: string): number {
  return Math.round(
    (expiresAt.getTime() - Date.parse(`${today}T00:00:00Z`)) / DAY_MS,
  );
}

/**
 * The alert a document is due, or null. The nearest threshold it has
 * reached is used, so a run missed for a few days still sends the right
 * alert, and each threshold is sent once per expiry date.
 */
export function alertThreshold(daysLeft: number): AlertThreshold | null {
  if (daysLeft <= 0) return 0;
  if (daysLeft <= 7) return 7;
  if (daysLeft <= 30) return 30;
  return null;
}

/**
 * The current copy of each document: per owner and type, the one that
 * expires last. A copy with no expiry, or a renewal that expires later,
 * replaces an older one, so a renewed insurance stops the alerts for the
 * copy it replaces. Then only those expiring within `withinDays` (or
 * already expired), soonest first.
 */
export function expiringDocuments(
  candidates: ExpiryCandidate[],
  today: string,
  withinDays: number,
): ExpiringDocument[] {
  const current = new Map<string, ExpiryCandidate>();
  for (const candidate of candidates) {
    const owner = candidate.aircraftId ?? candidate.operatorId;
    const key = `${candidate.kind}:${owner}:${candidate.type}`;
    const held = current.get(key);
    const later =
      !held ||
      candidate.expiresAt === null ||
      (held.expiresAt !== null && candidate.expiresAt > held.expiresAt);
    if (later) current.set(key, candidate);
  }
  return [...current.values()]
    .filter((doc): doc is ExpiringDocument => doc.expiresAt !== null)
    .map((doc) => ({ ...doc, daysLeft: daysUntil(doc.expiresAt, today) }))
    .filter((doc) => doc.daysLeft <= withinDays)
    .sort(
      (a, b) =>
        a.expiresAt.getTime() - b.expiresAt.getTime() ||
        a.documentId.localeCompare(b.documentId),
    );
}

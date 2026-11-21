/** PostgreSQL `lock_not_available`: a `lock_timeout` ran out. */
const LOCK_NOT_AVAILABLE = '55P03';

/**
 * True when a transaction failed only because it waited too long or lost a
 * race, so the same request may succeed if sent again:
 * - P2028: the interactive transaction could not start within `maxWait`,
 *   or ran past its `timeout` (Prisma's transaction API);
 * - P2034: a deadlock or serialisation failure;
 * - SQLSTATE 55P03: a lock wait passed `SET LOCAL lock_timeout`. Through the
 *   pg driver adapter it has no P-code of its own (P2010 from a raw query,
 *   P2039 from a model query); the SQLSTATE is on the driver error.
 */
export function isLockFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, meta } = error as { code?: unknown; meta?: unknown };
  if (code === 'P2028' || code === 'P2034') return true;
  const cause = (
    meta as { driverAdapterError?: { cause?: Record<string, unknown> } }
  )?.driverAdapterError?.cause;
  return (
    cause?.originalCode === LOCK_NOT_AVAILABLE ||
    cause?.code === LOCK_NOT_AVAILABLE
  );
}

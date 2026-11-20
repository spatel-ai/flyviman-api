import { PricingRuleType, Role } from '../../generated/prisma/enums.js';

/**
 * Audit records whose contents are commercial: pricing rules carry the
 * commission, markup, fee and tax settings, which security-rbac.md keeps for
 * finance and super admins. Other internal roles still see that such a record
 * exists (who, what, when) but not its before, after or reason.
 *
 * Exception: operations set the matching limits (MATCHING_LIMITS), so they
 * see the contents of those records, and of no other pricing rule.
 */
const COMMERCIAL_ENTITIES: ReadonlySet<string> = new Set(['PricingRule']);
const COMMERCIAL_READERS: ReadonlySet<Role> = new Set([
  Role.FINANCE_ADMIN,
  Role.SUPER_ADMIN,
]);

export interface AuditContents {
  entityType: string;
  before: unknown;
  after: unknown;
}

export function canReadAuditContents(log: AuditContents, role: Role): boolean {
  if (!COMMERCIAL_ENTITIES.has(log.entityType)) return true;
  if (COMMERCIAL_READERS.has(role)) return true;
  return role === Role.OPS && isMatchingLimitsRecord(log);
}

/** Every snapshot present names MATCHING_LIMITS, and at least one is present. */
function isMatchingLimitsRecord(log: AuditContents): boolean {
  const types = [log.before, log.after]
    .filter((s) => s !== null && s !== undefined)
    .map((s) =>
      typeof s === 'object' ? (s as { type?: unknown }).type : null,
    );
  return (
    types.length > 0 &&
    types.every((t) => t === PricingRuleType.MATCHING_LIMITS)
  );
}

/**
 * Passenger and medical fields (rule 8), by key at any depth, with the
 * audit-log readers allowed to see each group (security-rbac.md). Keys are
 * compared lowercased with `_` and `-` removed, so `first_name` and
 * `First-Name` match `firstName`. Audit payloads should never hold them; this
 * is the backstop if one ever does.
 * - Medical: the super administrator only (operations only as a request's
 *   assigned owner, which an audit row cannot show).
 * - Identity documents: masked except to the owner and the fulfilling
 *   operator, neither of whom reads the audit log. Any key starting with
 *   `documentnumber` or `passport` counts.
 * - Passenger details: operations and the super administrator. A passenger
 *   container (`passengers`, `passenger`, ...) is redacted whole.
 */
const normaliseKey = (key: string): string =>
  key.toLowerCase().replace(/[_-]/g, '');

const keySet = (...keys: string[]): ((key: string) => boolean) => {
  const set = new Set(keys.map(normaliseKey));
  return (key) => set.has(key);
};

const RESTRICTED_FIELDS: ReadonlyArray<{
  matches: (normalisedKey: string) => boolean;
  readers: ReadonlySet<Role>;
}> = [
  {
    matches: keySet(
      'medical',
      'medicalDetails',
      'medicalNotes',
      'medicalHistory',
      'medicalDocuments',
      'diagnosis',
      'patientCondition',
      'medications',
      'allergies',
      'specialAssistance',
    ),
    readers: new Set([Role.SUPER_ADMIN]),
  },
  {
    matches: (key) =>
      key.startsWith('documentnumber') ||
      key.startsWith('passport') ||
      key === 'documentexpiry',
    readers: new Set(),
  },
  {
    matches: keySet(
      'passengers',
      'passenger',
      'bookingPassengers',
      'passengerDetails',
      'firstName',
      'lastName',
      'gender',
      'documentType',
      'dateOfBirth',
      'nationality',
      'specialRequests',
    ),
    readers: new Set([Role.OPS, Role.SUPER_ADMIN]),
  },
];

/**
 * Replaces each restricted field the role may not read with null. A value
 * that is not an object, array or null (for example a JSON string, whose keys
 * cannot be inspected) is withheld whole from every role but the super
 * administrator.
 */
export function redactRestricted(
  value: unknown,
  role: Role,
): { value: unknown; redacted: boolean } {
  if (value !== null && value !== undefined && typeof value !== 'object') {
    return role === Role.SUPER_ADMIN
      ? { value, redacted: false }
      : { value: null, redacted: true };
  }
  const groups = RESTRICTED_FIELDS.filter((group) => !group.readers.has(role));
  const isHidden = (key: string) => {
    const normalised = normaliseKey(key);
    return groups.some((group) => group.matches(normalised));
  };
  let redacted = false;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node === null || typeof node !== 'object') return node;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node)) {
      if (isHidden(key) && child !== null && child !== undefined) {
        out[key] = null;
        redacted = true;
      } else {
        out[key] = walk(child);
      }
    }
    return out;
  };
  return { value: walk(value), redacted };
}

/**
 * What a role is shown of a record's before, after and reason. `restricted`
 * is true when any of it was withheld or redacted, so a reader can say so
 * rather than show blanks.
 */
export function presentAuditContents(
  log: AuditContents & { reason: string | null },
  role: Role,
): {
  before: unknown;
  after: unknown;
  reason: string | null;
  restricted: boolean;
} {
  if (!canReadAuditContents(log, role)) {
    const empty = (v: unknown) => v === null || v === undefined;
    return {
      before: null,
      after: null,
      reason: null,
      restricted: !(empty(log.before) && empty(log.after) && empty(log.reason)),
    };
  }
  const before = redactRestricted(log.before ?? null, role);
  const after = redactRestricted(log.after ?? null, role);
  return {
    before: before.value,
    after: after.value,
    reason: log.reason,
    restricted: before.redacted || after.redacted,
  };
}

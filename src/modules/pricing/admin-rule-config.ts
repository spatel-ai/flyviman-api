import type {
  AircraftCategory,
  PricingRuleScope,
  PricingRuleType,
} from '../../generated/prisma/enums.js';

/**
 * Rule types Flyviman's finance team sets through `/admin/pricing-rules`
 * (M5 slice 3; pricing-engine.md, "Who edits what"). Only types the engine
 * applies today: a markup, service fee or discount would be stored and then
 * silently ignored, so they arrive with the engine change that applies them.
 * `MIN_BILLABLE_HOURS` and `POSITIONING` are platform defaults here; operators
 * override them for their own organisation and aircraft.
 */
export const ADMIN_RULE_TYPES = [
  'COMMISSION',
  'TAX',
  'MIN_CHARGE',
  'ROUTING_FACTOR',
  'TIME_ALLOWANCE',
  'VALIDITY',
  'MIN_BILLABLE_HOURS',
  'POSITIONING',
] as const satisfies readonly PricingRuleType[];

export type AdminRuleType = (typeof ADMIN_RULE_TYPES)[number];

/** Category rules refine the platform default for one aircraft category. */
export const ADMIN_RULE_SCOPES = [
  'PLATFORM',
  'CATEGORY',
] as const satisfies readonly PricingRuleScope[];

export type AdminRuleScope = (typeof ADMIN_RULE_SCOPES)[number];

/** ₹10 crore in paise; matches the operator inputs' ceiling. */
export const MAX_RULE_MINOR = 10_000_000_000;

export function isAdminRuleType(type: string): type is AdminRuleType {
  return (ADMIN_RULE_TYPES as readonly string[]).includes(type);
}

export type ConfigCheck =
  | { ok: true; config: Record<string, unknown> }
  | { ok: false; errors: { field: string; message: string }[] };

type Field =
  | { kind: 'number'; min: number; max: number; decimals: number }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'text'; min: number; max: number };

interface Shape {
  required: Record<string, Field>;
  optional?: Record<string, Field & { default: unknown }>;
}

const percent = (max: number): Field => ({
  kind: 'number',
  min: 0,
  max,
  decimals: 2,
});

/** Exact config shape and bounds per type; nothing else is accepted. */
const SHAPES: Record<AdminRuleType, Shape> = {
  COMMISSION: {
    required: {
      percent: percent(50),
      mode: { kind: 'enum', values: ['ADD_ON', 'DEDUCTED'] },
    },
  },
  TAX: {
    required: {
      name: { kind: 'text', min: 2, max: 40 },
      percent: percent(40),
    },
  },
  MIN_CHARGE: {
    required: {
      amountMinor: { kind: 'number', min: 0, max: MAX_RULE_MINOR, decimals: 0 },
    },
  },
  ROUTING_FACTOR: {
    required: { factor: { kind: 'number', min: 1, max: 1.5, decimals: 3 } },
  },
  TIME_ALLOWANCE: {
    required: { minutes: { kind: 'number', min: 0, max: 120, decimals: 0 } },
  },
  VALIDITY: {
    required: {
      minutes: { kind: 'number', min: 5, max: 10_080, decimals: 0 },
    },
  },
  MIN_BILLABLE_HOURS: {
    required: { hours: { kind: 'number', min: 0.5, max: 12, decimals: 2 } },
  },
  POSITIONING: {
    required: {
      rateFactor: { kind: 'number', min: 0, max: 2, decimals: 2 },
    },
    optional: {
      freeWithinKm: {
        kind: 'number',
        min: 0,
        max: 1000,
        decimals: 0,
        default: 0,
      },
    },
  },
};

/**
 * Checks and normalises a rule's configuration: every required field
 * present and in bounds, optional fields defaulted, unknown fields refused,
 * text trimmed. Pure, so the API and its tests share one definition.
 */
export function checkRuleConfig(
  type: AdminRuleType,
  config: unknown,
): ConfigCheck {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return {
      ok: false,
      errors: [{ field: 'config', message: 'config must be an object.' }],
    };
  }
  const source = config as Record<string, unknown>;
  const shape = SHAPES[type];
  const fields = { ...shape.required, ...shape.optional };
  const errors: { field: string; message: string }[] = [];
  const out: Record<string, unknown> = {};

  for (const key of Object.keys(source)) {
    if (!(key in fields)) {
      errors.push({
        field: `config.${key}`,
        message: `${key} is not a setting of ${type}.`,
      });
    }
  }
  for (const [key, field] of Object.entries(fields)) {
    const value = source[key];
    if (value === undefined || value === null) {
      const optional = shape.optional?.[key];
      if (optional) out[key] = optional.default;
      else
        errors.push({ field: `config.${key}`, message: `${key} is required.` });
      continue;
    }
    const problem = checkField(field, value);
    if (problem) errors.push({ field: `config.${key}`, message: problem });
    else out[key] = typeof value === 'string' ? value.trim() : value;
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, config: out };
}

function checkField(field: Field, value: unknown): string | null {
  switch (field.kind) {
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return 'must be a number.';
      }
      if (value < field.min || value > field.max) {
        return `must be between ${field.min} and ${field.max}.`;
      }
      const scaled = value * 10 ** field.decimals;
      if (Math.abs(scaled - Math.round(scaled)) > 1e-9) {
        return field.decimals === 0
          ? 'must be a whole number.'
          : `must have at most ${field.decimals} decimal places.`;
      }
      return null;
    }
    case 'enum':
      return typeof value === 'string' && field.values.includes(value)
        ? null
        : `must be one of ${field.values.join(', ')}.`;
    case 'text': {
      if (typeof value !== 'string') return 'must be text.';
      const length = value.trim().length;
      if (length < field.min || length > field.max) {
        return `must be ${field.min} to ${field.max} characters.`;
      }
      return hasHiddenCharacter(value)
        ? 'must be one line of plain text.'
        : null;
    }
  }
}

/** Control characters (line breaks included) and text-direction overrides. */
function hasHiddenCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (
      code < 0x20 ||
      code === 0x7f ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      return true;
    }
  }
  return false;
}

/** A platform rule has no reference; a category rule names its category. */
export function checkScopeRef(
  scope: AdminRuleScope,
  scopeRef: string | null | undefined,
  categories: readonly AircraftCategory[],
): string | null {
  if (scope === 'PLATFORM') {
    return scopeRef == null ? null : 'A platform rule has no scopeRef.';
  }
  return scopeRef != null &&
    (categories as readonly string[]).includes(scopeRef)
    ? null
    : `scopeRef must be an aircraft category: ${categories.join(', ')}.`;
}

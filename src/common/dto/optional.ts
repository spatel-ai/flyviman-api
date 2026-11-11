import { ValidateIf } from 'class-validator';

/**
 * For a field that may be left out of an update but may not be `null`.
 * Unlike `@IsOptional()`, a `null` is validated (and so rejected by the
 * field's other rules) instead of being passed through to the database.
 */
export const OptionalNotNull = () =>
  ValidateIf((_object, value) => value !== undefined);

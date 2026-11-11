import { HttpStatus } from '@nestjs/common';
import argon2 from 'argon2';
import { AppException } from '../errors/app.exception.js';

/** Minimum length for a new password (docs/architecture/security-rbac.md). */
export const PASSWORD_MIN_LENGTH = 12;

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export async function verifyPassword(
  hash: string,
  password: string,
): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    // A malformed stored hash is a failed check, not a server error.
    return false;
  }
}

/**
 * Passwords seen so often in breaches that they are refused outright. This
 * short list is the built-in check; a breached-password service can be put
 * behind the same function later.
 */
const COMMON = new Set([
  'password1234',
  'password12345',
  'passwordpassword',
  '123456789012',
  '1234567890123',
  'qwertyuiop12',
  'qwertyuiopas',
  'qwerty123456',
  'iloveyou1234',
  'administrator',
  'letmein12345',
  'welcome12345',
  'abcdefghijkl',
  'abc123abc123',
  '111111111111',
  '000000000000',
]);

/** Why a new password is not acceptable, or `null` when it is. */
export function passwordIssue(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `must be at least ${PASSWORD_MIN_LENGTH} characters`;
  }
  if (COMMON.has(password.toLowerCase()) || /^(.)\1+$/.test(password)) {
    return 'is too common; choose something harder to guess';
  }
  return null;
}

/** Refuses a new password that does not meet the policy. */
export function assertAcceptablePassword(password: string): void {
  const issue = passwordIssue(password);
  if (issue) {
    throw new AppException(
      'VALIDATION_ERROR',
      'Choose a different password.',
      HttpStatus.BAD_REQUEST,
      [{ field: 'password', issue }],
    );
  }
}

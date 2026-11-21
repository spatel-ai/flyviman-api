import { describe, expect, it } from 'vitest';
import { isLockFailure } from './lock-failure.js';

function driverError(code: string, originalCode: string) {
  return {
    code,
    meta: {
      driverAdapterError: {
        cause: { kind: 'postgres', code: originalCode, originalCode },
      },
    },
  };
}

describe('isLockFailure', () => {
  it('a transaction timeout or wait (P2028) and a deadlock (P2034)', () => {
    expect(isLockFailure({ code: 'P2028' })).toBe(true);
    expect(isLockFailure({ code: 'P2034' })).toBe(true);
  });

  it('lock_timeout (55P03) from a raw query or a model query', () => {
    expect(isLockFailure(driverError('P2010', '55P03'))).toBe(true);
    expect(isLockFailure(driverError('P2039', '55P03'))).toBe(true);
  });

  it('anything else is not retryable here', () => {
    expect(isLockFailure(driverError('P2010', '23514'))).toBe(false);
    expect(isLockFailure({ code: 'P2002' })).toBe(false);
    expect(isLockFailure(new Error('boom'))).toBe(false);
    expect(isLockFailure(null)).toBe(false);
    expect(isLockFailure('P2028')).toBe(false);
  });
});

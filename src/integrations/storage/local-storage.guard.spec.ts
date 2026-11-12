import { NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { LocalStorageGuard } from './local-storage.guard.js';

function guard(values: Record<string, unknown>) {
  return new LocalStorageGuard({
    get: (key: string) => values[key],
  } as unknown as ConfigService);
}

describe('LocalStorageGuard', () => {
  it('opens the routes with development tools or local storage', () => {
    expect(guard({ ENABLE_DEV_TOOLS: true }).canActivate()).toBe(true);
    expect(
      guard({
        ENABLE_DEV_TOOLS: false,
        STORAGE_PROVIDER: 'local',
      }).canActivate(),
    ).toBe(true);
  });

  it('answers 404 otherwise', () => {
    expect(() =>
      guard({
        ENABLE_DEV_TOOLS: false,
        STORAGE_PROVIDER: 'mock',
      }).canActivate(),
    ).toThrow(NotFoundException);
  });
});

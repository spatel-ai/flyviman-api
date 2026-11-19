import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { NoStoreInterceptor } from './no-store.interceptor.js';

function run(isPublic: boolean | undefined, existing?: string) {
  const headers: Record<string, string> = existing
    ? { 'Cache-Control': existing }
    : {};
  const response = {
    getHeader: (name: string) => headers[name],
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    },
  };
  const context = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ExecutionContext;
  const reflector = {
    getAllAndOverride: vi.fn().mockReturnValue(isPublic),
  } as unknown as Reflector;
  new NoStoreInterceptor(reflector).intercept(context, {
    handle: () => of(null),
  } as CallHandler);
  return headers['Cache-Control'];
}

describe('NoStoreInterceptor', () => {
  it('marks a signed-in route private, no-store', () => {
    expect(run(undefined)).toBe('private, no-store');
  });
  it('leaves a public route alone', () => {
    expect(run(true)).toBeUndefined();
  });
  it('does not override a header already set', () => {
    expect(run(undefined, 'max-age=60')).toBe('max-age=60');
  });
});

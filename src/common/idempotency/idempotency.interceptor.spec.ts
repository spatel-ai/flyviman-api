import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of, throwError } from 'rxjs';
import { AppException } from '../errors/app.exception.js';
import { IdempotencyInterceptor } from './idempotency.interceptor.js';
import { IdempotencyRecord, IdempotencyStore } from './idempotency.store.js';

class MemoryStore extends IdempotencyStore {
  readonly records = new Map<string, IdempotencyRecord>();

  async begin(key: string, fingerprint: string) {
    const existing = this.records.get(key);
    if (existing) return existing;
    this.records.set(key, { fingerprint, state: 'pending' });
    return null;
  }
  async complete(key: string, record: IdempotencyRecord) {
    this.records.set(key, record);
  }
  async release(key: string) {
    this.records.delete(key);
  }
}

const KEY = '7b1f4c7e-52f6-4d5c-9d8e-2f6f0a1b3c4d';

function setup(required = true) {
  const store = new MemoryStore();
  const reflector = {
    getAllAndOverride: () => required,
  } as unknown as Reflector;
  const interceptor = new IdempotencyInterceptor(reflector, store);
  const response = {
    statusCode: 201,
    status: vi.fn(),
    setHeader: vi.fn(),
  };

  function call(
    options: { key?: string; body?: unknown; userId?: string } = {},
    handler: () => unknown = () => ({ reference: 'FLY-1' }),
  ) {
    const key = 'key' in options ? options.key : KEY;
    const request = {
      method: 'POST',
      baseUrl: '/api/v1',
      path: '/bookings',
      body: options.body ?? { seats: 2 },
      user: { id: options.userId ?? 'user-1' },
      header: (name: string) => (name === 'idempotency-key' ? key : undefined),
    };
    const context = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
    } as unknown as ExecutionContext;
    const handle = vi.fn(() => {
      try {
        return of(handler());
      } catch (error) {
        return throwError(() => error);
      }
    });
    const result = (async () =>
      firstValueFrom(interceptor.intercept(context, { handle })))();
    return { result, handle };
  }

  return { store, response, call };
}

describe('IdempotencyInterceptor', () => {
  it('leaves routes that are not marked alone', async () => {
    const { call, store } = setup(false);
    const { result } = call({ key: undefined });
    await expect(result).resolves.toEqual({ reference: 'FLY-1' });
    expect(store.records.size).toBe(0);
  });

  it('requires a UUID key', async () => {
    const { call } = setup();
    for (const key of [undefined, 'abc']) {
      await expect(call({ key }).result).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
    }
  });

  it('runs the handler once and replays the stored response', async () => {
    const { call, response } = setup();
    const first = call();
    await expect(first.result).resolves.toEqual({ reference: 'FLY-1' });

    const repeat = call({}, () => ({ reference: 'FLY-2' }));
    await expect(repeat.result).resolves.toEqual({ reference: 'FLY-1' });
    expect(repeat.handle).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(201);
  });

  it('refuses the same key with a different body', async () => {
    const { call } = setup();
    await call().result;
    const error = await call({ body: { seats: 3 } }).result.catch(
      (e: AppException) => e,
    );
    expect(error).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect((error as AppException).getStatus()).toBe(409);
  });

  it('refuses a repeat while the first request is still running', async () => {
    const { call, store, response } = setup();
    await call().result;
    for (const record of store.records.values()) record.state = 'pending';

    await expect(call().result).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '2');
  });

  it('frees the key when the handler fails, so a retry can run', async () => {
    const { call, store } = setup();
    const failed = call({}, () => {
      throw new Error('boom');
    });
    await expect(failed.result).rejects.toThrow('boom');
    expect(store.records.size).toBe(0);

    await expect(call().result).resolves.toEqual({ reference: 'FLY-1' });
  });

  it('keeps one caller from replaying another caller’s response', async () => {
    const { call } = setup();
    await call({ userId: 'user-1' }).result;
    const other = call({ userId: 'user-2' }, () => ({ reference: 'FLY-9' }));
    await expect(other.result).resolves.toEqual({ reference: 'FLY-9' });
    expect(other.handle).toHaveBeenCalled();
  });
});

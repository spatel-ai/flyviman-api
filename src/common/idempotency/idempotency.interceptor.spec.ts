import { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, from } from 'rxjs';
import { IS_PUBLIC } from '../../modules/auth/auth.decorators.js';
import { AppException } from '../errors/app.exception.js';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import {
  IdempotencyInterceptor,
  idempotencyScope,
} from './idempotency.interceptor.js';
import {
  IdempotencyClaim,
  IdempotencyLease,
  IdempotencyRecord,
  IdempotencyStore,
} from './idempotency.store.js';

/**
 * The same conditional writes as PrismaIdempotencyStore: a unique
 * (scope, key) on insert, and every later write matched on the owner token.
 */
class MemoryStore extends IdempotencyStore {
  readonly rows = new Map<
    string,
    IdempotencyRecord & { scope: string; key: string }
  >();
  private next = 1;

  async insert(scope: string, key: string, lease: IdempotencyLease) {
    for (const row of this.rows.values())
      if (row.scope === scope && row.key === key) return null;
    const id = `k-${this.next++}`;
    this.rows.set(id, {
      id,
      scope,
      key,
      ...lease,
      status: 'IN_PROGRESS',
      responseStatus: null,
      responseBody: null,
    });
    return id;
  }
  async find(scope: string, key: string) {
    for (const row of this.rows.values())
      if (row.scope === scope && row.key === key) return { ...row };
    return null;
  }
  async takeOver(id: string, previousOwner: string, lease: IdempotencyLease) {
    const row = this.rows.get(id);
    if (row?.ownerToken !== previousOwner) return false;
    Object.assign(row, lease, {
      status: 'IN_PROGRESS',
      responseStatus: null,
      responseBody: null,
    });
    return true;
  }
  async complete(claim: IdempotencyClaim, status: number, body: unknown) {
    const row = this.owned(claim);
    if (row && (row.status === 'IN_PROGRESS' || row.status === 'COMMITTED'))
      Object.assign(row, {
        status: 'COMPLETED',
        responseStatus: status,
        responseBody: body,
      });
  }
  async abandon(claim: IdempotencyClaim, clientError: boolean) {
    const row = this.owned(claim);
    if (row?.status === 'IN_PROGRESS' && clientError) this.rows.delete(row.id);
    else if (row?.status === 'IN_PROGRESS' || row?.status === 'COMMITTED')
      row.status = 'FAILED';
  }
  async purgeExpired(now: Date) {
    let deleted = 0;
    for (const row of this.rows.values())
      if (row.expiresAt < now && this.rows.delete(row.id)) deleted += 1;
    return deleted;
  }
  /** What markIdempotencyCommitted does inside the handler's transaction. */
  commit(claim: IdempotencyClaim) {
    const row = this.owned(claim);
    if (row?.status !== 'IN_PROGRESS') throw new Error('claim lost');
    row.status = 'COMMITTED';
  }
  only() {
    const [row] = [...this.rows.values()];
    return row;
  }
  private owned(claim: IdempotencyClaim) {
    const row = this.rows.get(claim.id);
    return row?.ownerToken === claim.ownerToken ? row : undefined;
  }
}

const KEY = '7b1f4c7e-52f6-4d5c-9d8e-2f6f0a1b3c4d';
const LOCK_SECONDS = 300;
const DATA_KEY = Buffer.alloc(32, 7).toString('base64');
const T0 = new Date('2026-11-19T10:00:00.000Z');

function setup(required = true, dataKey = DATA_KEY, isPublic = false) {
  const store = new MemoryStore();
  const reflector = {
    getAllAndOverride: (key: string) =>
      key === IS_PUBLIC ? isPublic : required,
  } as unknown as Reflector;
  const config = {
    getOrThrow: (name: string) =>
      name === 'DATA_ENCRYPTION_KEY' ? dataKey : LOCK_SECONDS,
  } as unknown as ConfigService;
  const interceptor = new IdempotencyInterceptor(reflector, store, config);
  const created: string[] = [];

  /**
   * One request. By default its handler commits a record (the way a route
   * calls markIdempotencyCommitted) and answers with its reference. `gate`
   * holds the handler until released, to overlap requests.
   */
  function call(
    options: {
      key?: string;
      body?: unknown;
      /** `null`: no signed-in user. */
      userId?: string | null;
      path?: string;
      gate?: Promise<void>;
    } = {},
    handler: (commit: () => void) => unknown = (commit) => {
      commit();
      created.push(`FLY-${created.length + 1}`);
      return { reference: created.at(-1) };
    },
  ) {
    const key = 'key' in options ? options.key : KEY;
    const response = {
      statusCode: 201,
      status: vi.fn(),
      setHeader: vi.fn(),
    };
    const request = {
      method: 'POST',
      baseUrl: '',
      path: options.path ?? '/api/v1/bookings',
      route: { path: '/api/v1/bookings' },
      params: {},
      body: options.body ?? { seats: 2 },
      user:
        options.userId === null
          ? undefined
          : { id: options.userId ?? 'user-1' },
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
      // The claim this request was given, as it stood when its handler began.
      const row = [...store.rows.values()].find(
        (r) =>
          r.scope.startsWith(`${request.user?.id ?? 'anonymous'}:`) &&
          r.key === key,
      );
      const claim = row && { id: row.id, ownerToken: row.ownerToken };
      return from(
        (async () => {
          await options.gate;
          return handler(() => claim && store.commit(claim));
        })(),
      );
    });
    const result = (async () =>
      firstValueFrom(interceptor.intercept(context, { handle })))();
    return { result, handle, response };
  }

  return { store, call, created };
}

async function conflict(result: Promise<unknown>) {
  const error = (await result.catch((e: unknown) => e)) as AppException;
  expect(error).toBeInstanceOf(AppException);
  expect(error.code).toBe('IDEMPOTENCY_CONFLICT');
  expect(error.getStatus()).toBe(409);
  return error;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('IdempotencyInterceptor', () => {
  it('leaves routes that are not marked alone', async () => {
    const { call, store } = setup(false);
    const { result } = call({ key: undefined });
    await expect(result).resolves.toEqual({ reference: 'FLY-1' });
    expect(store.rows.size).toBe(0);
  });

  it('requires a UUID key', async () => {
    const { call } = setup();
    for (const key of [undefined, 'abc']) {
      await expect(call({ key }).result).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
    }
  });

  it('completed: runs once and replays the stored response', async () => {
    const { call, store, created } = setup();
    await expect(call().result).resolves.toEqual({ reference: 'FLY-1' });
    expect(store.only()).toMatchObject({
      status: 'COMPLETED',
      responseStatus: 201,
      scope: 'user-1:POST:/api/v1/bookings',
      lockedUntil: new Date(T0.getTime() + LOCK_SECONDS * 1000),
      expiresAt: new Date(T0.getTime() + 24 * 3600 * 1000),
    });

    const repeat = call();
    await expect(repeat.result).resolves.toEqual({ reference: 'FLY-1' });
    expect(repeat.handle).not.toHaveBeenCalled();
    expect(repeat.response.status).toHaveBeenCalledWith(201);
    expect(repeat.response.setHeader).toHaveBeenCalledWith(
      'Idempotent-Replayed',
      'true',
    );
    expect(created).toEqual(['FLY-1']);
  });

  it('mismatched body: the same key with a different body is refused', async () => {
    const { call, created } = setup();
    await call().result;
    await conflict(call({ body: { seats: 3 } }).result);
    expect(created).toHaveLength(1);
  });

  it('in flight: a repeat while the first runs is refused with Retry-After, and one record is made', async () => {
    const { call, created } = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const first = call({ gate });
    await vi.waitFor(() => expect(first.handle).toHaveBeenCalled());

    const repeat = call();
    await conflict(repeat.result);
    expect(repeat.response.setHeader).toHaveBeenCalledWith('Retry-After', '2');
    expect(repeat.handle).not.toHaveBeenCalled();

    release();
    await expect(first.result).resolves.toEqual({ reference: 'FLY-1' });
    expect(created).toEqual(['FLY-1']);
  });

  it('expired lock: a repeat takes over a dead request, which can then no longer commit', async () => {
    const { call, store, created } = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const stuck = call({ gate });
    await vi.waitFor(() => expect(stuck.handle).toHaveBeenCalled());

    vi.setSystemTime(T0.getTime() + LOCK_SECONDS * 1000 + 1);
    const retry = call();
    await expect(retry.result).resolves.toEqual({ reference: 'FLY-1' });

    // The first request wakes up: its commit matches nothing and it fails,
    // leaving the retry's completed record alone.
    release();
    await expect(stuck.result).rejects.toThrow('claim lost');
    expect(created).toEqual(['FLY-1']);
    expect(store.only()).toMatchObject({ status: 'COMPLETED' });
  });

  it('failed before committing: the key is freed so a retry can run', async () => {
    const { call, store } = setup();
    const failed = call({}, () => {
      throw new AppException('VALIDATION_ERROR', 'bad', 400);
    });
    await expect(failed.result).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(store.rows.size).toBe(0);
    await expect(call().result).resolves.toEqual({ reference: 'FLY-1' });
  });

  it('server error before committing: the key is kept, since a provider may already have been called', async () => {
    const { call, store, created } = setup();
    const failed = call({}, () => {
      throw new Error('gateway timed out');
    });
    await expect(failed.result).rejects.toThrow('gateway timed out');
    expect(store.only()).toMatchObject({ status: 'FAILED' });

    const repeat = call();
    await conflict(repeat.result);
    expect(repeat.handle).not.toHaveBeenCalled();
    expect(created).toEqual([]);
  });

  it('failed after committing: the key is kept and never replayed as a success', async () => {
    const { call, store, created } = setup();
    const failed = call({}, (commit) => {
      commit();
      created.push('FLY-1');
      throw new Error('mail server down');
    });
    await expect(failed.result).rejects.toThrow('mail server down');
    expect(store.only()).toMatchObject({ status: 'FAILED' });

    const repeat = call();
    const error = await conflict(repeat.result);
    expect(error.message).toMatch(/may have taken effect/);
    expect(repeat.handle).not.toHaveBeenCalled();

    // Not even once the lock has run out.
    vi.setSystemTime(T0.getTime() + LOCK_SECONDS * 1000 + 1);
    await conflict(call().result);
    expect(created).toEqual(['FLY-1']);
  });

  it('committed but never completed (a crash): waits for the lock, then reports the outcome as unknown', async () => {
    const { call, store, created } = setup();
    await call().result;
    Object.assign(store.only(), { status: 'COMMITTED', responseBody: null });

    const during = call();
    await conflict(during.result);
    expect(during.response.setHeader).toHaveBeenCalledWith('Retry-After', '2');

    vi.setSystemTime(T0.getTime() + LOCK_SECONDS * 1000 + 1);
    const after = call();
    const error = await conflict(after.result);
    expect(error.message).toMatch(/may have taken effect/);
    expect(after.handle).not.toHaveBeenCalled();
    expect(created).toEqual(['FLY-1']);
  });

  it('expired key: after 24 hours the key can be used again, even with another body', async () => {
    const { call, created } = setup();
    await call().result;
    vi.setSystemTime(T0.getTime() + 24 * 3600 * 1000);
    await expect(call({ body: { seats: 3 } }).result).resolves.toEqual({
      reference: 'FLY-2',
    });
    expect(created).toEqual(['FLY-1', 'FLY-2']);
  });

  it('lost Redis: the key is held only by the store, so nothing else can let a repeat through', async () => {
    // Structural: keys live only in the durable store (PostgreSQL), with no
    // Redis in front of it, so a replay depends on the store alone.
    const { call, store, created } = setup();
    await call().result;
    const replay = call();
    await expect(replay.result).resolves.toEqual({ reference: 'FLY-1' });
    expect(store.rows.size).toBe(1);
    expect(created).toEqual(['FLY-1']);
  });

  it('keeps one caller from replaying another caller’s response', async () => {
    const { call } = setup();
    await call({ userId: 'user-1' }).result;
    const other = call({ userId: 'user-2' });
    await expect(other.result).resolves.toEqual({ reference: 'FLY-2' });
    expect(other.handle).toHaveBeenCalled();
  });

  it('refuses a signed-in route that has no user, rather than share the anonymous scope', async () => {
    const { call, store } = setup();
    const { result, handle } = call({ userId: null });
    await expect(result).rejects.toThrow(
      /@Idempotent\(\) on a route that is not @Public\(\) needs a signed-in user/,
    );
    expect(handle).not.toHaveBeenCalled();
    expect(store.rows.size).toBe(0);
  });

  it('lets a public route without a user claim in the anonymous scope', async () => {
    const { call, store } = setup(true, DATA_KEY, true);
    await expect(call({ userId: null }).result).resolves.toEqual({
      reference: 'FLY-1',
    });
    expect(store.only().scope).toBe('anonymous:POST:/api/v1/bookings');
  });

  it('lets a signed-in route with a user claim in that user’s scope', async () => {
    const { call, store } = setup();
    await expect(call().result).resolves.toEqual({ reference: 'FLY-1' });
    expect(store.only().scope).toBe('user-1:POST:/api/v1/bookings');
  });

  it('a race lost between insert and read claims again', async () => {
    const { call, store } = setup();
    // The first insert loses to a request that then fails and frees the key.
    const insert = store.insert.bind(store);
    let raced = false;
    store.insert = async (scope, key, lease) => {
      if (!raced) {
        raced = true;
        return null;
      }
      return insert(scope, key, lease);
    };
    await expect(call().result).resolves.toEqual({ reference: 'FLY-1' });
  });
});

describe('idempotencyScope', () => {
  function request(fields: Record<string, unknown>): Request {
    return {
      method: 'POST',
      baseUrl: '',
      path: '/api/v1/bookings',
      params: {},
      ...fields,
    } as unknown as Request;
  }

  it('uses the route template, not the literal URL', () => {
    const route = { path: '/api/v1/bookings' };
    const plain = idempotencyScope(
      request({ route, path: '/api/v1/bookings' }),
    );
    const odd = idempotencyScope(request({ route, path: '/api/v1/BOOKINGS/' }));
    expect(plain).toBe('anonymous:POST:/api/v1/bookings');
    expect(odd).toBe(plain);
  });

  it('adds the caller and the path parameters, sorted by name', () => {
    const scope = idempotencyScope(
      request({
        user: { id: 'user-1' },
        route: { path: '/api/v1/bookings/:id/payments/:kind' },
        params: { kind: 'full', id: 'b-1' },
      }),
    );
    expect(scope).toBe(
      'user-1:POST:/api/v1/bookings/:id/payments/:kind:[["id","b-1"],["kind","full"]]',
    );
    const other = idempotencyScope(
      request({
        user: { id: 'user-1' },
        route: { path: '/api/v1/bookings/:id/payments/:kind' },
        params: { id: 'b-2', kind: 'full' },
      }),
    );
    expect(other).not.toBe(scope);
  });

  it('falls back to the path where no route matched', () => {
    expect(idempotencyScope(request({ route: undefined }))).toBe(
      'anonymous:POST:/api/v1/bookings',
    );
  });
});

describe('IdempotencyInterceptor request hash', () => {
  it('is an HMAC keyed from the server secret, not a plain SHA-256', async () => {
    const first = setup();
    await first.call().result;
    const hash = first.store.only().requestHash;
    const plain = createHash('sha256')
      .update(JSON.stringify({ seats: 2 }))
      .digest('hex');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(plain);

    const otherKey = setup(true, Buffer.alloc(32, 9).toString('base64'));
    await otherKey.call().result;
    expect(otherKey.store.only().requestHash).not.toBe(hash);
  });

  it('a repeat at another spelling of the URL is the same request', async () => {
    const { call, store, created } = setup();
    await call({ path: '/api/v1/bookings' }).result;
    const replay = call({ path: '/api/v1/Bookings/' });
    await expect(replay.result).resolves.toEqual({ reference: 'FLY-1' });
    expect(created).toHaveLength(1);
    expect(store.rows.size).toBe(1);
  });
});

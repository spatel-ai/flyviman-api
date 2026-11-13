import { describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { AccountTokensService } from './account-tokens.service.js';

/** Just enough of Redis for the token service, in memory (expiry ignored). */
function fakeRedis() {
  const store = new Map<string, string>();
  const commands = {
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    getdel: (key: string) => {
      const value = store.get(key) ?? null;
      store.delete(key);
      return Promise.resolve(value);
    },
    set: (key: string, value: string, ...options: string[]) => {
      const previous = store.get(key) ?? null;
      store.set(key, value);
      return Promise.resolve(options.includes('GET') ? previous : 'OK');
    },
    del: (...keys: string[]) => {
      keys.forEach((key) => store.delete(key));
      return Promise.resolve(keys.length);
    },
    multi: () => {
      const queued: (() => void)[] = [];
      const transaction = {
        del: (key: string) => {
          queued.push(() => store.delete(key));
          return transaction;
        },
        set: (key: string, value: string) => {
          queued.push(() => store.set(key, value));
          return transaction;
        },
        exec: () => {
          queued.forEach((run) => run());
          return Promise.resolve([]);
        },
      };
      return transaction;
    },
  };
  return commands as unknown as Redis;
}

describe('AccountTokensService', () => {
  it('uses a token once', async () => {
    const tokens = new AccountTokensService(fakeRedis());
    const token = await tokens.issue('user-1', 'invitation');
    expect(await tokens.consume(token)).toEqual({
      userId: 'user-1',
      purpose: 'invitation',
    });
    expect(await tokens.consume(token)).toBeNull();
  });

  it('cancels the previous link when a new one is issued', async () => {
    const tokens = new AccountTokensService(fakeRedis());
    const first = await tokens.issue('user-1', 'invitation');
    const second = await tokens.issue('user-1', 'invitation');
    expect(await tokens.consume(first)).toBeNull();
    expect(await tokens.consume(second)).not.toBeNull();
  });

  it('keeps purposes and accounts apart', async () => {
    const tokens = new AccountTokensService(fakeRedis());
    const invite = await tokens.issue('user-1', 'invitation');
    await tokens.issue('user-1', 'password-reset');
    await tokens.issue('user-2', 'invitation');
    expect(await tokens.consume(invite)).not.toBeNull();
  });

  it('revokes the current link on request', async () => {
    const tokens = new AccountTokensService(fakeRedis());
    const token = await tokens.issue('user-1', 'invitation');
    await tokens.revokeFor('user-1', 'invitation');
    expect(await tokens.consume(token)).toBeNull();
    await expect(
      tokens.revokeFor('user-1', 'invitation'),
    ).resolves.toBeUndefined();
  });
});

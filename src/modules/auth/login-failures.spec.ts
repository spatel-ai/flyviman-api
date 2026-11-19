import type { Redis } from 'ioredis';
import { LoginFailures, lockoutAddress } from './login-failures.js';

describe('lockoutAddress', () => {
  it('counts an IPv6 address by its /64, as the rate limiter does', () => {
    expect(lockoutAddress('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe(
      '2001:db8:1:2::/64',
    );
    expect(lockoutAddress('2001:db8:1:2::9')).toBe('2001:db8:1:2::/64');
  });

  it('keeps IPv4 and IPv4-mapped addresses as they are', () => {
    expect(lockoutAddress('203.0.113.7')).toBe('203.0.113.7');
    expect(lockoutAddress('::ffff:203.0.113.7')).toBe('::ffff:203.0.113.7');
    expect(lockoutAddress('::1')).toBe('::1');
  });

  it('names a missing address', () => {
    expect(lockoutAddress(null)).toBe('unknown');
  });
});

describe('LoginFailures', () => {
  it('locks one IPv6 subnet, not just the address that failed', async () => {
    const counts = new Map<string, number>();
    const redis = {
      eval: vi.fn((_script: string, _n: number, key: string) => {
        counts.set(key, (counts.get(key) ?? 0) + 1);
        return Promise.resolve(counts.get(key));
      }),
      mget: vi.fn((...keys: string[]) =>
        Promise.resolve(keys.map((key) => String(counts.get(key) ?? 0))),
      ),
    };
    const failures = new LoginFailures(redis as unknown as Redis);
    for (let index = 1; index <= 10; index += 1) {
      await failures.record('a@example.test', `2001:db8:1:2::${index}`);
    }
    await expect(
      failures.assertNotLocked('a@example.test', '2001:db8:1:2::ffff'),
    ).rejects.toMatchObject({ status: 429 });
    await expect(
      failures.assertNotLocked('a@example.test', '2001:db8:1:3::1'),
    ).resolves.toBeUndefined();
  });
});

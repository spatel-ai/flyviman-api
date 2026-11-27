import { describe, expect, it } from 'vitest';
import { demoSeedRefusal } from './seed-demo-guard.js';

const local = {
  NODE_ENV: 'development',
  ENABLE_DEV_TOOLS: 'true',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db?schema=public',
};

describe('demoSeedRefusal', () => {
  it('accepts a local development database', () => {
    expect(demoSeedRefusal(local)).toBeNull();
    expect(
      demoSeedRefusal({ ...local, DATABASE_URL: 'postgresql://u@[::1]/db' }),
    ).toBeNull();
  });
  it('refuses production', () => {
    expect(demoSeedRefusal({ ...local, NODE_ENV: 'production' })).toMatch(
      /production/,
    );
  });
  it('refuses when dev tools are off', () => {
    expect(demoSeedRefusal({ ...local, ENABLE_DEV_TOOLS: 'false' })).toMatch(
      /ENABLE_DEV_TOOLS/,
    );
  });
  it('refuses a remote host, preferring the migration URL', () => {
    const remote = 'postgresql://u:p@db.example.com:5432/db';
    expect(demoSeedRefusal({ ...local, DATABASE_URL: remote })).toMatch(
      /this machine/,
    );
    expect(
      demoSeedRefusal({ ...local, MIGRATION_DATABASE_URL: remote }),
    ).toMatch(/this machine/);
  });
  it('refuses a host or hostaddr query parameter, which the driver prefers', () => {
    for (const param of ['host=evil.example.com', 'hostaddr=203.0.113.9']) {
      expect(
        demoSeedRefusal({
          ...local,
          DATABASE_URL: `postgresql://u:p@localhost/db?${param}`,
        }),
      ).toMatch(/this machine/);
    }
    expect(
      demoSeedRefusal({
        ...local,
        DATABASE_URL: 'postgresql://u:p@localhost/db?sslmode=disable&HOST=x',
      }),
    ).toMatch(/this machine/);
  });
  it('refuses a missing database URL', () => {
    expect(
      demoSeedRefusal({ NODE_ENV: 'test', ENABLE_DEV_TOOLS: 'true' }),
    ).toMatch(/this machine/);
  });
});

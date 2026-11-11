import { NodeEnv, validateEnv } from './env.validation.js';

const valid = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  JWT_ACCESS_SECRET: 'x'.repeat(32),
  DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
};

describe('validateEnv', () => {
  it('applies defaults and converts PORT to a number', () => {
    const env = validateEnv({ ...valid, PORT: '4100' });

    expect(env.PORT).toBe(4100);
    expect(env.NODE_ENV).toBe(NodeEnv.Development);
    expect(env.WEB_ORIGIN).toBe('http://localhost:3000');
    expect(env.ACCESS_TOKEN_TTL_SECONDS).toBe(900);
    expect(env.RATE_LIMIT_AUTH_PER_MINUTE).toBe(5);
  });

  it('rejects a short or missing JWT_ACCESS_SECRET', () => {
    for (const secret of [undefined, 'too-short']) {
      expect(() =>
        validateEnv({ ...valid, JWT_ACCESS_SECRET: secret }),
      ).toThrow(/JWT_ACCESS_SECRET/);
    }
  });

  it('keeps the development helpers off unless asked, and never in production', () => {
    expect(validateEnv(valid).ENABLE_DEV_TOOLS).toBe(false);
    expect(
      validateEnv({ ...valid, ENABLE_DEV_TOOLS: 'true' }).ENABLE_DEV_TOOLS,
    ).toBe(true);
    expect(() =>
      validateEnv({
        ...valid,
        ENABLE_DEV_TOOLS: 'true',
        NODE_ENV: 'production',
      }),
    ).toThrow(/ENABLE_DEV_TOOLS/);
  });

  it('rejects a missing DATABASE_URL', () => {
    expect(() => validateEnv({})).toThrow(/Invalid environment configuration/);
  });

  it('rejects an out-of-range PORT', () => {
    expect(() => validateEnv({ ...valid, PORT: '70000' })).toThrow(
      /Invalid environment configuration/,
    );
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => validateEnv({ ...valid, NODE_ENV: 'staging' })).toThrow(
      /Invalid environment configuration/,
    );
  });
});

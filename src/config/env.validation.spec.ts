import { NodeEnv, validateEnv } from './env.validation.js';

const valid = {
  NODE_ENV: 'development',
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

  it('allows the development helpers only for a web app on localhost', () => {
    const devTools = { ...valid, ENABLE_DEV_TOOLS: 'true' };
    for (const origin of [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://[::1]:3000',
    ]) {
      expect(
        validateEnv({ ...devTools, WEB_ORIGIN: origin }).ENABLE_DEV_TOOLS,
      ).toBe(true);
    }
    for (const origin of [
      'https://staging.flyviman.com',
      'http://localhost.evil.example',
      'not a url',
    ]) {
      expect(() => validateEnv({ ...devTools, WEB_ORIGIN: origin })).toThrow(
        /localhost/,
      );
    }
  });

  it('runs a proof-of-concept server with the sink and local storage, never the dev tools', () => {
    const poc = {
      ...valid,
      NODE_ENV: 'production',
      WEB_ORIGIN: 'https://flyviman-web.example.com',
      MESSAGING_PROVIDER: 'sink',
      STORAGE_PROVIDER: 'local',
      API_PUBLIC_URL: 'https://flyviman-api.example.com',
    };
    const env = validateEnv(poc);
    expect(env.MESSAGING_PROVIDER).toBe('sink');
    expect(env.STORAGE_PROVIDER).toBe('local');
    expect(env.ENABLE_DEV_TOOLS).toBe(false);
    // Local storage on a shared server needs its public address.
    expect(() => validateEnv({ ...poc, API_PUBLIC_URL: undefined })).toThrow(
      /API_PUBLIC_URL/,
    );
    // The development outbox stays refused.
    expect(() => validateEnv({ ...poc, ENABLE_DEV_TOOLS: 'true' })).toThrow(
      /ENABLE_DEV_TOOLS/,
    );
    // Signed links never travel over plain HTTP in production.
    expect(() =>
      validateEnv({
        ...poc,
        API_PUBLIC_URL: 'http://flyviman-api.example.com',
      }),
    ).toThrow(/https/);
    // On Render the public address comes from the platform.
    expect(
      validateEnv({
        ...poc,
        API_PUBLIC_URL: undefined,
        RENDER_EXTERNAL_URL: 'https://flyviman-api.onrender.com',
      }).API_PUBLIC_URL,
    ).toBe('https://flyviman-api.onrender.com');
    // Only the known providers.
    expect(() => validateEnv({ ...poc, MESSAGING_PROVIDER: 'smtp' })).toThrow(
      /MESSAGING_PROVIDER/,
    );
  });

  it('needs the real operations inbox in production when messages are really sent', () => {
    const production = {
      ...valid,
      NODE_ENV: 'production',
      WEB_ORIGIN: 'https://flyviman-web.example.com',
      MESSAGING_PROVIDER: 'mock',
    };
    expect(() => validateEnv(production)).toThrow(/OPERATIONS_INBOX_EMAIL/);
    expect(
      validateEnv({ ...production, OPERATIONS_INBOX_EMAIL: 'ops@flyviman.com' })
        .OPERATIONS_INBOX_EMAIL,
    ).toBe('ops@flyviman.com');
    // A host that discards every message does not need one.
    expect(() =>
      validateEnv({
        ...production,
        MESSAGING_PROVIDER: 'sink',
        STORAGE_PROVIDER: 'local',
        API_PUBLIC_URL: 'https://flyviman-api.example.com',
      }),
    ).not.toThrow();
  });

  it('gives enquiries their own limit, not the sign-in one', () => {
    expect(validateEnv(valid).RATE_LIMIT_ENQUIRY_PER_WINDOW).toBe(5);
    expect(
      validateEnv({ ...valid, RATE_LIMIT_AUTH_PER_MINUTE: '100' })
        .RATE_LIMIT_ENQUIRY_PER_WINDOW,
    ).toBe(5);
  });

  it('rejects a missing DATABASE_URL', () => {
    expect(() => validateEnv({})).toThrow(/Invalid environment configuration/);
  });

  it('rejects an out-of-range PORT', () => {
    expect(() => validateEnv({ ...valid, PORT: '70000' })).toThrow(
      /Invalid environment configuration/,
    );
  });

  it('rejects a missing NODE_ENV', () => {
    const { NODE_ENV: _omitted, ...rest } = valid;
    expect(() => validateEnv(rest)).toThrow(/NODE_ENV/);
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => validateEnv({ ...valid, NODE_ENV: 'staging' })).toThrow(
      /Invalid environment configuration/,
    );
  });
});

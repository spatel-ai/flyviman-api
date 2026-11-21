import {
  DEV_PAYMENT_KEY_SECRET,
  DEV_PAYMENT_WEBHOOK_SECRET,
  NodeEnv,
  validateEnv,
} from './env.validation.js';

/** What a deployed server sets: its own payment secrets. */
const PAYMENT_SECRETS = {
  PAYMENT_KEY_SECRET: 'k'.repeat(24),
  PAYMENT_WEBHOOK_SECRET: 'w'.repeat(24),
};

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

  it('turns WhatsApp on by default, and off by default in production', () => {
    expect(validateEnv(valid).WHATSAPP_ENABLED).toBe(true);
    expect(
      validateEnv({ ...valid, WHATSAPP_ENABLED: 'false' }).WHATSAPP_ENABLED,
    ).toBe(false);
    const production = {
      ...valid,
      ...PAYMENT_SECRETS,
      NODE_ENV: 'production',
      WEB_ORIGIN: 'https://flyviman-web.example.com',
      MESSAGING_PROVIDER: 'sink',
    };
    expect(validateEnv(production).WHATSAPP_ENABLED).toBe(false);
    expect(
      validateEnv({ ...production, WHATSAPP_ENABLED: 'true' }).WHATSAPP_ENABLED,
    ).toBe(true);
  });

  it('rejects a short or missing JWT_ACCESS_SECRET', () => {
    for (const secret of [undefined, 'too-short']) {
      expect(() =>
        validateEnv({ ...valid, JWT_ACCESS_SECRET: secret }),
      ).toThrow(/JWT_ACCESS_SECRET/);
    }
  });

  it('accepts no WEB_PROXY_SECRET, and refuses a short one', () => {
    expect(validateEnv(valid).WEB_PROXY_SECRET).toBeUndefined();
    expect(
      validateEnv({ ...valid, WEB_PROXY_SECRET: 's'.repeat(32) })
        .WEB_PROXY_SECRET,
    ).toBe('s'.repeat(32));
    expect(() =>
      validateEnv({ ...valid, WEB_PROXY_SECRET: 'too-short' }),
    ).toThrow(/WEB_PROXY_SECRET/);
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
      ...PAYMENT_SECRETS,
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
      ...PAYMENT_SECRETS,
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

  it('only warns about an unrestricted database role unless asked to refuse', () => {
    expect(validateEnv(valid).REQUIRE_RESTRICTED_DB_ROLE).toBe(false);
    expect(
      validateEnv({ ...valid, REQUIRE_RESTRICTED_DB_ROLE: 'true' })
        .REQUIRE_RESTRICTED_DB_ROLE,
    ).toBe(true);
    expect(
      validateEnv({ ...valid, REQUIRE_RESTRICTED_DB_ROLE: 'false' })
        .REQUIRE_RESTRICTED_DB_ROLE,
    ).toBe(false);
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
  it('defaults to the mock payment gateway, accepts only mock or razorpay, and only manual settlement', () => {
    const env = validateEnv(valid);
    expect(env.PAYMENT_PROVIDER).toBe('mock');
    expect(env.SETTLEMENT_MODE).toBe('manual');

    for (const provider of ['stripe', '']) {
      expect(() =>
        validateEnv({ ...valid, PAYMENT_PROVIDER: provider }),
      ).toThrow(/PAYMENT_PROVIDER must be mock or razorpay/);
    }
    expect(() =>
      validateEnv({ ...valid, SETTLEMENT_MODE: 'razorpay_route' }),
    ).toThrow(/SETTLEMENT_MODE=razorpay_route is not built yet/);
    expect(() =>
      validateEnv({ ...valid, SETTLEMENT_MODE: 'automatic' }),
    ).toThrow(/SETTLEMENT_MODE/);
  });

  it('defaults the payment secrets outside production and needs real ones in production', () => {
    const env = validateEnv(valid);
    expect(env.PAYMENT_KEY_SECRET).toBe(DEV_PAYMENT_KEY_SECRET);
    expect(env.PAYMENT_WEBHOOK_SECRET).toBe(DEV_PAYMENT_WEBHOOK_SECRET);

    const production = {
      ...valid,
      ...PAYMENT_SECRETS,
      NODE_ENV: 'production',
      WEB_ORIGIN: 'https://flyviman-web.example.com',
      MESSAGING_PROVIDER: 'sink',
      STORAGE_PROVIDER: 'local',
      API_PUBLIC_URL: 'https://flyviman-api.example.com',
    };
    expect(validateEnv(production).PAYMENT_WEBHOOK_SECRET).toBe('w'.repeat(24));
    for (const [name, value] of [
      ['PAYMENT_KEY_SECRET', undefined],
      ['PAYMENT_WEBHOOK_SECRET', undefined],
      ['PAYMENT_KEY_SECRET', DEV_PAYMENT_KEY_SECRET],
      ['PAYMENT_WEBHOOK_SECRET', DEV_PAYMENT_WEBHOOK_SECRET],
    ] as const) {
      expect(() => validateEnv({ ...production, [name]: value })).toThrow(
        new RegExp(name),
      );
    }
    expect(() =>
      validateEnv({ ...valid, PAYMENT_WEBHOOK_SECRET: 'short' }),
    ).toThrow(/PAYMENT_WEBHOOK_SECRET/);
  });

  describe('Razorpay', () => {
    const keys = {
      RAZORPAY_KEY_ID: 'rzp_test_AbC123xyz',
      RAZORPAY_KEY_SECRET: 's'.repeat(24),
    };

    it('refuses razorpay without both API key values', () => {
      for (const missing of [
        {},
        { RAZORPAY_KEY_ID: keys.RAZORPAY_KEY_ID },
        { RAZORPAY_KEY_SECRET: keys.RAZORPAY_KEY_SECRET },
        { ...keys, RAZORPAY_KEY_SECRET: '' },
      ]) {
        expect(() =>
          validateEnv({ ...valid, PAYMENT_PROVIDER: 'razorpay', ...missing }),
        ).toThrow(/PAYMENT_PROVIDER=razorpay needs RAZORPAY_KEY_ID/);
      }
    });

    it('accepts razorpay with its keys; the webhook secret is optional', () => {
      const env = validateEnv({
        ...valid,
        PAYMENT_PROVIDER: 'razorpay',
        ...keys,
      });
      expect(env.PAYMENT_PROVIDER).toBe('razorpay');
      expect(env.RAZORPAY_WEBHOOK_SECRET).toBeUndefined();
      expect(
        validateEnv({
          ...valid,
          PAYMENT_PROVIDER: 'razorpay',
          ...keys,
          RAZORPAY_WEBHOOK_SECRET: 'h'.repeat(20),
        }).RAZORPAY_WEBHOOK_SECRET,
      ).toBe('h'.repeat(20));
    });

    it('refuses a malformed key ID and short secrets', () => {
      for (const bad of [
        { RAZORPAY_KEY_ID: 'key_123' },
        { RAZORPAY_KEY_ID: 'rzp_test_' },
        { RAZORPAY_KEY_SECRET: 'short' },
        { RAZORPAY_WEBHOOK_SECRET: 'short' },
      ]) {
        expect(() =>
          validateEnv({
            ...valid,
            PAYMENT_PROVIDER: 'razorpay',
            ...keys,
            ...bad,
          }),
        ).toThrow(/Invalid environment configuration/);
      }
    });

    it('in production needs the Razorpay keys, not the mock secrets', () => {
      const production = {
        ...valid,
        NODE_ENV: 'production',
        WEB_ORIGIN: 'https://flyviman-web.example.com',
        MESSAGING_PROVIDER: 'sink',
        STORAGE_PROVIDER: 'local',
        API_PUBLIC_URL: 'https://flyviman-api.example.com',
        PAYMENT_PROVIDER: 'razorpay',
      };
      expect(validateEnv({ ...production, ...keys }).PAYMENT_PROVIDER).toBe(
        'razorpay',
      );
      expect(() => validateEnv(production)).toThrow(/RAZORPAY_KEY_ID/);
    });

    it('refuses a live key unless ALLOW_LIVE_PAYMENTS=true (Hard gate)', () => {
      const live = {
        ...valid,
        PAYMENT_PROVIDER: 'razorpay',
        ...keys,
        RAZORPAY_KEY_ID: 'rzp_live_AbC123xyz',
      };
      expect(validateEnv(valid).ALLOW_LIVE_PAYMENTS).toBe(false);
      for (const flag of [undefined, 'false', '1', 'yes']) {
        expect(() =>
          validateEnv({ ...live, ALLOW_LIVE_PAYMENTS: flag }),
        ).toThrow(/live key.*ALLOW_LIVE_PAYMENTS=true.*Hard gate/);
      }
      expect(
        validateEnv({ ...live, ALLOW_LIVE_PAYMENTS: 'true' }).RAZORPAY_KEY_ID,
      ).toBe('rzp_live_AbC123xyz');
      // A test key needs no flag; the mock ignores a live key it never uses.
      expect(
        validateEnv({ ...valid, PAYMENT_PROVIDER: 'razorpay', ...keys })
          .PAYMENT_PROVIDER,
      ).toBe('razorpay');
      expect(
        validateEnv({ ...valid, RAZORPAY_KEY_ID: 'rzp_live_AbC123xyz' })
          .PAYMENT_PROVIDER,
      ).toBe('mock');
    });

    it('ignores blank Razorpay values while the mock is in use', () => {
      const env = validateEnv({
        ...valid,
        RAZORPAY_KEY_ID: '',
        RAZORPAY_KEY_SECRET: '',
        RAZORPAY_WEBHOOK_SECRET: '',
      });
      expect(env.PAYMENT_PROVIDER).toBe('mock');
      expect(env.RAZORPAY_KEY_ID).toBeUndefined();
    });
  });
});

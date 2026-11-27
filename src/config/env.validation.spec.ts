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

/** What a deployed server behind the web host's proxy sets (D-065). */
const PROXY_SECRET = { WEB_PROXY_SECRET: 'p'.repeat(32) };

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
      ...PROXY_SECRET,
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

  it('needs WEB_PROXY_SECRET in production behind the web host proxy (no COOKIE_DOMAIN)', () => {
    const production = {
      ...valid,
      ...PAYMENT_SECRETS,
      NODE_ENV: 'production',
      WEB_ORIGIN: 'https://flyviman-web.example.com',
      MESSAGING_PROVIDER: 'sink',
    };
    const refused =
      /WEB_PROXY_SECRET is required in production when COOKIE_DOMAIN is unset/;
    expect(() => validateEnv(production)).toThrow(refused);
    expect(() => validateEnv({ ...production, COOKIE_DOMAIN: '' })).toThrow(
      refused,
    );
    expect(
      validateEnv({ ...production, ...PROXY_SECRET }).WEB_PROXY_SECRET,
    ).toBe(PROXY_SECRET.WEB_PROXY_SECRET);
    // One domain for the site and the API: no proxy, so no secret needed.
    expect(
      validateEnv({ ...production, COOKIE_DOMAIN: '.flyviman.com' })
        .WEB_PROXY_SECRET,
    ).toBeUndefined();
    // Not required outside production.
    expect(validateEnv(valid).WEB_PROXY_SECRET).toBeUndefined();
  });

  it('caps the token lifetimes and the refresh grace period', () => {
    for (const [name, min, max] of [
      ['ACCESS_TOKEN_TTL_SECONDS', 60, 3600],
      ['REFRESH_TOKEN_TTL_DAYS', 1, 90],
      ['REFRESH_ROTATION_GRACE_SECONDS', 0, 60],
    ] as const) {
      expect(validateEnv({ ...valid, [name]: String(min) })[name]).toBe(min);
      expect(validateEnv({ ...valid, [name]: String(max) })[name]).toBe(max);
      for (const bad of [min - 1, max + 1]) {
        expect(() => validateEnv({ ...valid, [name]: String(bad) })).toThrow(
          new RegExp(name),
        );
      }
    }
    const env = validateEnv(valid);
    expect(env.REFRESH_TOKEN_TTL_DAYS).toBe(30);
    expect(env.REFRESH_ROTATION_GRACE_SECONDS).toBe(10);
  });

  it('trusts one proxy hop by default in production only, and takes 0 to 5', () => {
    const production = {
      ...valid,
      ...PAYMENT_SECRETS,
      ...PROXY_SECRET,
      NODE_ENV: 'production',
      WEB_ORIGIN: 'https://flyviman-web.example.com',
      MESSAGING_PROVIDER: 'sink',
    };
    expect(validateEnv(valid).TRUST_PROXY_HOPS).toBe(0);
    expect(
      validateEnv({ ...valid, TRUST_PROXY_HOPS: '' }).TRUST_PROXY_HOPS,
    ).toBe(0);
    expect(validateEnv(production).TRUST_PROXY_HOPS).toBe(1);
    // A blank value is unset, never 0, which would stop trusting the proxy.
    expect(
      validateEnv({ ...production, TRUST_PROXY_HOPS: '' }).TRUST_PROXY_HOPS,
    ).toBe(1);
    expect(
      validateEnv({ ...production, TRUST_PROXY_HOPS: '0' }).TRUST_PROXY_HOPS,
    ).toBe(0);
    expect(
      validateEnv({ ...production, TRUST_PROXY_HOPS: '2' }).TRUST_PROXY_HOPS,
    ).toBe(2);
    expect(
      validateEnv({ ...valid, TRUST_PROXY_HOPS: '5' }).TRUST_PROXY_HOPS,
    ).toBe(5);
    for (const bad of ['6', '-1', '1.5', 'abc']) {
      expect(() => validateEnv({ ...valid, TRUST_PROXY_HOPS: bad })).toThrow(
        /TRUST_PROXY_HOPS/,
      );
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
      ...PAYMENT_SECRETS,
      ...PROXY_SECRET,
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
    expect(() => validateEnv({ ...poc, MESSAGING_PROVIDER: 'twilio' })).toThrow(
      /MESSAGING_PROVIDER/,
    );
  });

  it('needs the real operations inbox in production when messages are really sent', () => {
    const production = {
      ...valid,
      ...PAYMENT_SECRETS,
      ...PROXY_SECRET,
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

  it('sends email by SMTP only with the account and its password', () => {
    const smtp = {
      ...valid,
      MESSAGING_PROVIDER: 'smtp',
      USER_EMAIL: 'owner@gmail.com',
      USER_EMAIL_PASSWORD: 'app-password',
    };
    const env = validateEnv(smtp);
    expect(env.SMTP_HOST).toBe('smtp.gmail.com');
    expect(env.SMTP_PORT).toBe(465);
    expect(env.EMAIL_FROM_NAME).toBe('Flyviman');
    expect(env.EMAIL_REDIRECT_TO).toBeUndefined();
    for (const name of ['USER_EMAIL', 'USER_EMAIL_PASSWORD']) {
      for (const value of [undefined, '']) {
        expect(() => validateEnv({ ...smtp, [name]: value })).toThrow(
          /USER_EMAIL and USER_EMAIL_PASSWORD/,
        );
      }
    }
    expect(() => validateEnv({ ...smtp, EMAIL_REDIRECT_TO: 'nope' })).toThrow(
      /EMAIL_REDIRECT_TO/,
    );
    // Empty placeholders copied from .env.example do not break other providers.
    expect(() =>
      validateEnv({
        ...valid,
        USER_EMAIL: '',
        USER_EMAIL_PASSWORD: '',
        EMAIL_REDIRECT_TO: '',
      }),
    ).not.toThrow();
  });

  it('counts smtp as really sending: production needs the real operations inbox', () => {
    const production = {
      ...valid,
      ...PAYMENT_SECRETS,
      ...PROXY_SECRET,
      NODE_ENV: 'production',
      WEB_ORIGIN: 'https://flyviman-web.example.com',
      MESSAGING_PROVIDER: 'smtp',
      STORAGE_PROVIDER: 'local',
      API_PUBLIC_URL: 'https://flyviman-api.example.com',
      USER_EMAIL: 'owner@gmail.com',
      USER_EMAIL_PASSWORD: 'app-password',
    };
    expect(() => validateEnv(production)).toThrow(/OPERATIONS_INBOX_EMAIL/);
    expect(() =>
      validateEnv({
        ...production,
        OPERATIONS_INBOX_EMAIL: 'ops@flyviman.com',
      }),
    ).not.toThrow();
    // Never every customer's email into one inbox in production.
    expect(() =>
      validateEnv({
        ...production,
        OPERATIONS_INBOX_EMAIL: 'ops@flyviman.com',
        EMAIL_REDIRECT_TO: 'owner@gmail.com',
      }),
    ).toThrow(/EMAIL_REDIRECT_TO must not be set in production/);
  });

  it('gives enquiries their own limit, not the sign-in one', () => {
    expect(validateEnv(valid).RATE_LIMIT_ENQUIRY_PER_WINDOW).toBe(5);
    expect(
      validateEnv({ ...valid, RATE_LIMIT_AUTH_PER_MINUTE: '100' })
        .RATE_LIMIT_ENQUIRY_PER_WINDOW,
    ).toBe(5);
  });

  it('ends a sign-in after 30 days by default, configurable from 1 to 365', () => {
    expect(validateEnv(valid).SESSION_MAX_AGE_DAYS).toBe(30);
    expect(
      validateEnv({ ...valid, SESSION_MAX_AGE_DAYS: '365' })
        .SESSION_MAX_AGE_DAYS,
    ).toBe(365);
    for (const days of ['0', '366', '1.5']) {
      expect(() =>
        validateEnv({ ...valid, SESSION_MAX_AGE_DAYS: days }),
      ).toThrow(/SESSION_MAX_AGE_DAYS/);
    }
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

  it('leaves PAYMENT_MAX_ORDER_MINOR unset by default and takes only whole paise from 100', () => {
    expect(validateEnv(valid).PAYMENT_MAX_ORDER_MINOR).toBeUndefined();
    expect(
      validateEnv({ ...valid, PAYMENT_MAX_ORDER_MINOR: '' })
        .PAYMENT_MAX_ORDER_MINOR,
    ).toBeUndefined();
    expect(
      validateEnv({ ...valid, PAYMENT_MAX_ORDER_MINOR: '12345678' })
        .PAYMENT_MAX_ORDER_MINOR,
    ).toBe(12_345_678);
    for (const bad of ['99', '1.5', 'lots', '-100']) {
      expect(() =>
        validateEnv({ ...valid, PAYMENT_MAX_ORDER_MINOR: bad }),
      ).toThrow(/PAYMENT_MAX_ORDER_MINOR/);
    }
  });

  it('defaults the payment secrets outside production and needs real ones in production', () => {
    const env = validateEnv(valid);
    expect(env.PAYMENT_KEY_SECRET).toBe(DEV_PAYMENT_KEY_SECRET);
    expect(env.PAYMENT_WEBHOOK_SECRET).toBe(DEV_PAYMENT_WEBHOOK_SECRET);

    const production = {
      ...valid,
      ...PAYMENT_SECRETS,
      ...PROXY_SECRET,
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

    it('refuses the public development secrets as Razorpay secrets', () => {
      for (const name of ['RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET']) {
        for (const secret of [
          DEV_PAYMENT_KEY_SECRET,
          DEV_PAYMENT_WEBHOOK_SECRET,
        ]) {
          expect(() =>
            validateEnv({
              ...valid,
              PAYMENT_PROVIDER: 'razorpay',
              ...keys,
              [name]: secret,
            }),
          ).toThrow(
            new RegExp(`${name} must not be a public development secret`),
          );
        }
      }
    });

    it('needs a webhook secret of at least 16 characters', () => {
      const razorpay = { ...valid, PAYMENT_PROVIDER: 'razorpay', ...keys };
      expect(() =>
        validateEnv({ ...razorpay, RAZORPAY_WEBHOOK_SECRET: 'h'.repeat(15) }),
      ).toThrow(/RAZORPAY_WEBHOOK_SECRET/);
      expect(
        validateEnv({ ...razorpay, RAZORPAY_WEBHOOK_SECRET: 'h'.repeat(16) })
          .RAZORPAY_WEBHOOK_SECRET,
      ).toBe('h'.repeat(16));
    });

    it('in production needs the Razorpay keys, not the mock secrets', () => {
      const production = {
        ...valid,
        ...PROXY_SECRET,
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

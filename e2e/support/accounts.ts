import 'dotenv/config';

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. See .env.example.`);
  return value;
}

/** Accounts created by `npm run db:seed`. */
export const ACCOUNTS = {
  superAdmin: {
    email: env('SEED_ADMIN_EMAIL'),
    password: env('SEED_ADMIN_PASSWORD'),
    role: 'SUPER_ADMIN',
  },
  ops: {
    email: 'ops@flyviman.test',
    password: env('SEED_LOCAL_PASSWORD'),
    role: 'OPS',
  },
  finance: {
    email: 'finance@flyviman.test',
    password: env('SEED_LOCAL_PASSWORD'),
    role: 'FINANCE_ADMIN',
  },
  operatorAdmin: {
    email: 'operator@flyviman.test',
    password: env('SEED_LOCAL_PASSWORD'),
    role: 'OPERATOR_ADMIN',
  },
  customer: {
    email: 'customer@flyviman.test',
    password: env('SEED_LOCAL_PASSWORD'),
    role: 'CUSTOMER',
  },
  suspended: {
    email: 'suspended@flyviman.test',
    password: env('SEED_LOCAL_PASSWORD'),
    role: 'CUSTOMER',
  },
} as const;

export type AccountName = keyof typeof ACCOUNTS;

/** Second server started by playwright.config.ts with production rate limits. */
export const STRICT_BASE_URL = `http://localhost:${Number(process.env.PORT ?? 4000) + 1}/api/v1/`;

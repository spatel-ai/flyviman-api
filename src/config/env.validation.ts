import 'reflect-metadata';
import { plainToInstance, Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';
import {
  DEV_PAYMENT_KEY_SECRET,
  DEV_PAYMENT_WEBHOOK_SECRET,
} from './payment-defaults.js';

export { DEV_PAYMENT_KEY_SECRET, DEV_PAYMENT_WEBHOOK_SECRET };

export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

/**
 * Environment variables the application needs to start. Variables for later
 * milestones (Razorpay keys, provider credentials) are added here when the
 * module that reads them is implemented. See `.env.example`.
 */
export class EnvironmentVariables {
  /** Required: a deployment that forgets it must not start as development. */
  @IsEnum(NodeEnv)
  NODE_ENV!: NodeEnv;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 4000;

  /**
   * The API's own connection: the restricted role, which cannot alter
   * tables or change the audit trail (docs/deployment.md).
   */
  @IsString()
  @IsNotEmpty()
  DATABASE_URL: string;

  /**
   * The tables' owner, for migrations and the seed only; the API never
   * connects with it. Unset, those use DATABASE_URL.
   */
  @IsOptional()
  @IsString()
  MIGRATION_DATABASE_URL?: string;

  /**
   * Refuse to start when DATABASE_URL owns the tables or may delete audit
   * records, instead of only warning. Off until a host has been moved to
   * the restricted role (docs/deployment.md); then set it to true.
   */
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  REQUIRE_RESTRICTED_DB_ROLE: boolean = false;

  /** Origin of flyviman-web, allowed by CORS with credentials. */
  @IsString()
  @IsNotEmpty()
  WEB_ORIGIN: string = 'http://localhost:3000';

  /**
   * One-time codes, reset and invitation tokens and sign-in failure counts.
   * (Rate-limit counters are in memory, per instance; idempotency keys are
   * in PostgreSQL.)
   */
  @IsString()
  @IsNotEmpty()
  REDIS_URL: string = 'redis://localhost:6379';

  /**
   * How long an idempotent request holds its key before a repeat may take
   * it over. Longer than the slowest provider call a handler makes; a
   * request that outruns it is rolled back, not run twice.
   */
  @Type(() => Number)
  @IsInt()
  @Min(30)
  @Max(3600)
  IDEMPOTENCY_LOCK_SECONDS: number = 300;

  /** Signs access tokens (HS256). At least 32 characters. */
  @IsString()
  @MinLength(32)
  JWT_ACCESS_SECRET: string;

  @Type(() => Number)
  @IsInt()
  @Min(60)
  ACCESS_TOKEN_TTL_SECONDS: number = 900;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  REFRESH_TOKEN_TTL_DAYS: number = 30;

  /**
   * A rotated refresh token presented again within this many seconds is
   * treated as two requests racing, not as theft. See AuthService.refresh.
   */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  REFRESH_ROTATION_GRACE_SECONDS: number = 10;

  /**
   * Successful refreshes (rotations) one sign-in may make a minute; more are
   * refused with 429 and the token stays usable. Bounds a stolen live token.
   */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  REFRESH_ROTATIONS_PER_MINUTE: number = 30;

  /** Seconds before another one-time code can be sent to the same address. */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  OTP_RESEND_COOLDOWN_SECONDS: number = 60;

  /** One-time codes one address can be sent in an hour. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  OTP_MAX_PER_HOUR: number = 5;

  /**
   * Parent domain shared by the web app and the API, for example
   * `.flyviman.com`. Leave unset locally so cookies are host-only.
   */
  @IsOptional()
  @IsString()
  COOKIE_DOMAIN?: string;

  /**
   * Shared with the web host (its own WEB_PROXY_SECRET), which signs the
   * visitor's address into `x-flyviman-client-ip` when it proxies `/api/v1`.
   * Unset, that header is ignored and every caller is its connection's
   * address. At least 32 characters.
   */
  @IsOptional()
  @IsString()
  @MinLength(32)
  WEB_PROXY_SECRET?: string;

  /** Requests per minute, per address, on each sign-in route. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  RATE_LIMIT_AUTH_PER_MINUTE: number = 5;

  /**
   * Requests per minute, per caller, on the public search routes that price
   * aircraft (`POST /search/*`, `GET /search/calendar`). Test servers lift it.
   */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  RATE_LIMIT_SEARCH_PER_MINUTE: number = 20;

  /** Requests per minute, per address, on every other route. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  RATE_LIMIT_DEFAULT_PER_MINUTE: number = 100;

  /**
   * Enquiries (`POST /enquiries`) one caller may send per window. Its own
   * number, never tied to the sign-in limit; test servers lift it.
   */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  RATE_LIMIT_ENQUIRY_PER_WINDOW: number = 5;

  /** The enquiry window, in seconds (10 minutes by default). */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  RATE_LIMIT_ENQUIRY_WINDOW_SECONDS: number = 600;

  /**
   * Booking requests (`POST /bookings`) one customer may send per window, on
   * top of the default tier. Test servers lift it.
   */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  RATE_LIMIT_BOOKING_PER_WINDOW: number = 10;

  /** The booking request window, in seconds (10 minutes by default). */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  RATE_LIMIT_BOOKING_WINDOW_SECONDS: number = 600;

  /**
   * Open booking requests (`REQUESTED` or `OPERATOR_PENDING`) one customer
   * may have at once, each holding an aircraft while the operator answers.
   */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  BOOKING_MAX_OPEN_PER_CUSTOMER: number = 5;

  /**
   * How long the operator has to answer a booking request, in hours: the
   * soft hold on the aircraft lasts this long (never past the trip's end),
   * and so does an operator's quote unless it sets its own `validUntil`
   * (product owner, 2026-11-20).
   */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(720)
  BOOKING_HOLD_HOURS: number = 48;

  /**
   * Payment gateway notifications (`POST /webhooks/payments/:provider`) per
   * minute, per address. Generous: the gateway retries and bursts.
   */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  RATE_LIMIT_WEBHOOK_PER_MINUTE: number = 120;

  /**
   * Where a new enquiry from the contact page is emailed: the operations
   * inbox. Deployments set the real address.
   */
  @IsEmail()
  OPERATIONS_INBOX_EMAIL: string = 'operations@flyviman.test';

  /**
   * Whether notifications also go over WhatsApp (M10). On in development and
   * tests (the mock only); when not set it is off in production, until a
   * provider and registered message templates exist.
   */
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  WHATSAPP_ENABLED: boolean = true;

  /**
   * Whether an operator's empty-leg offer waits for operations to approve it
   * before it is listed (M7). Off by default: publishing lists it at once.
   */
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  EMPTY_LEG_REVIEW_REQUIRED: boolean = false;

  /**
   * Encrypts sensitive columns (identity document numbers) and the session
   * pairs briefly kept in Redis for racing refreshes. 32 random bytes,
   * base64 encoded. Changing it makes existing values unreadable.
   */
  @IsString()
  @Matches(/^[A-Za-z0-9+/_-]{43}=?$/, {
    message: 'DATA_ENCRYPTION_KEY must be 32 bytes, base64 encoded',
  })
  DATA_ENCRYPTION_KEY: string;

  /** Where this API is reachable from a browser. Used in mock storage URLs. */
  @IsOptional()
  @IsString()
  API_PUBLIC_URL?: string;

  /** Folder the local-disk storage mock writes to. */
  @IsString()
  @IsNotEmpty()
  STORAGE_DIR: string = '.storage';

  /**
   * Turns on the development helpers: the messaging mock's outbox route,
   * the local-disk storage mock, and the seed's local accounts. Refused in
   * production, where the outbox would expose every one-time code.
   */
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  ENABLE_DEV_TOOLS: boolean = false;

  @IsIn(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
  LOG_LEVEL: string = 'info';

  /**
   * Who delivers email and SMS. `mock` is the development outbox and needs
   * ENABLE_DEV_TOOLS. `sink` accepts and discards every message, so a
   * shared server can run without a provider; codes and links never
   * arrive and are never exposed (D-064).
   */
  @IsIn(['mock', 'sink'])
  MESSAGING_PROVIDER: string = 'mock';

  /**
   * Where uploads go. `mock` is the development store and needs
   * ENABLE_DEV_TOOLS. `local` uses the same signed, expiring links on this
   * server's disk without development tools, for a proof of concept: files
   * are lost when the host's disk is wiped (D-064).
   */
  @IsIn(['mock', 'local'])
  STORAGE_PROVIDER: string = 'mock';

  /**
   * Where scheduled airline fares come from. Only `mock` (realistic Indian
   * domestic data, no network) until a supplier is chosen (decision 2).
   */
  @IsIn(['mock'])
  AIRLINE_PROVIDER: string = 'mock';

  /**
   * How long scheduled search waits for each airline supplier, in
   * milliseconds. A supplier that has not answered is reported as
   * `TIMEOUT` and the search returns the others' fares (partial).
   */
  @Type(() => Number)
  @IsInt()
  @Min(100)
  @Max(60000)
  AIRLINE_TIMEOUT_MS: number = 8000;

  /**
   * How long scheduled fares stay valid after a search or a revalidation,
   * in minutes. A search past it answers 404 and is run again.
   */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(120)
  AIRLINE_OFFER_TTL_MINUTES: number = 15;

  /**
   * The payment gateway. Only `mock` exists in this build: it moves no
   * money, and payments must not go live until the commercial decisions
   * are settled (docs/open-decisions.md, Hard gate). Razorpay will be added
   * as another value with its own adapter.
   */
  @IsIn(['mock'], {
    message:
      'PAYMENT_PROVIDER must be mock: only the mock payment gateway exists in this build',
  })
  PAYMENT_PROVIDER: string = 'mock';

  /**
   * The gateway's key secret (signs the checkout result) and webhook secret
   * (signs every notification). Only in the API's environment, never logged
   * or sent to the browser. Required in production; elsewhere they default
   * to the mock's development values (`DEV_PAYMENT_KEY_SECRET`,
   * `DEV_PAYMENT_WEBHOOK_SECRET`), which tests sign with.
   */
  @IsOptional()
  @IsString()
  @MinLength(16)
  PAYMENT_KEY_SECRET?: string;

  @IsOptional()
  @IsString()
  @MinLength(16)
  PAYMENT_WEBHOOK_SECRET?: string;

  /**
   * How collected money reaches operators (open decision 8). `manual`:
   * Flyviman collects and settlements are recorded and paid by hand.
   * `razorpay_route` (automatic split to operators' linked accounts) is
   * reserved and refused until it is built.
   */
  @IsIn(['manual', 'razorpay_route'])
  SETTLEMENT_MODE: string = 'manual';

  /**
   * Who issues payment receipts (W4-1): the name, and optionally the postal
   * address, email and phone printed on them. A receipt is not a GST tax
   * invoice (open decision 13), so no tax registration is asked for here.
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  RECEIPT_ISSUER_NAME: string = 'Flyviman';

  @IsOptional()
  @IsString()
  @MaxLength(300)
  RECEIPT_ISSUER_ADDRESS?: string;

  @IsOptional()
  @IsEmail()
  RECEIPT_ISSUER_EMAIL?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  RECEIPT_ISSUER_PHONE?: string;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function isLocalOrigin(origin: string | undefined): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(origin ?? '').hostname);
  } catch {
    return false;
  }
}

export function validateEnv(
  config: Record<string, unknown>,
): EnvironmentVariables {
  // Render tells a web service its own public address; use it when
  // API_PUBLIC_URL is not set, so signed storage links cannot point at the
  // wrong host (D-065).
  const source =
    !config.API_PUBLIC_URL && config.RENDER_EXTERNAL_URL
      ? { ...config, API_PUBLIC_URL: config.RENDER_EXTERNAL_URL }
      : config;
  const validated = plainToInstance(EnvironmentVariables, source);
  if (
    source.WHATSAPP_ENABLED === undefined &&
    validated.NODE_ENV === NodeEnv.Production
  ) {
    validated.WHATSAPP_ENABLED = false;
  }
  const errors = validateSync(validated, { skipMissingProperties: false });

  if (validated.ENABLE_DEV_TOOLS && validated.NODE_ENV === NodeEnv.Production) {
    throw new Error(
      'Invalid environment configuration: ENABLE_DEV_TOOLS must not be set in production',
    );
  }
  // Development tools expose reset and invitation links through a public
  // route, so they are only for a developer's machine and automated tests:
  // the web app they serve must be on this machine too.
  if (validated.ENABLE_DEV_TOOLS && !isLocalOrigin(validated.WEB_ORIGIN)) {
    throw new Error(
      'Invalid environment configuration: ENABLE_DEV_TOOLS is allowed only when WEB_ORIGIN is on localhost. Shared servers need a real messaging and storage provider.',
    );
  }

  // Signed storage links must point at this API's public address, not at
  // localhost, once the server is not a developer's machine.
  if (
    validated.STORAGE_PROVIDER === 'local' &&
    !validated.ENABLE_DEV_TOOLS &&
    !validated.API_PUBLIC_URL
  ) {
    throw new Error(
      'Invalid environment configuration: STORAGE_PROVIDER=local needs API_PUBLIC_URL, the public address of this API.',
    );
  }

  // Refused rather than quietly settled by hand: an operator expecting an
  // automatic split would never be paid.
  if (validated.SETTLEMENT_MODE === 'razorpay_route') {
    throw new Error(
      'Invalid environment configuration: SETTLEMENT_MODE=razorpay_route is not built yet; use manual.',
    );
  }

  // Signed links are bearer credentials: never over plain HTTP in production,
  // except on this machine (the automated proof-of-concept test).
  if (
    validated.NODE_ENV === NodeEnv.Production &&
    validated.API_PUBLIC_URL &&
    !validated.API_PUBLIC_URL.startsWith('https://') &&
    !isLocalOrigin(validated.API_PUBLIC_URL)
  ) {
    throw new Error(
      'Invalid environment configuration: API_PUBLIC_URL must use https in production.',
    );
  }

  if (errors.length > 0) {
    const problems = errors
      .map((error) => Object.values(error.constraints ?? {}).join(', '))
      .join('; ');
    throw new Error(`Invalid environment configuration: ${problems}`);
  }

  // A deployed server signs with its own secrets: the development values
  // are in the repository, so anyone could forge a payment with them.
  if (validated.NODE_ENV === NodeEnv.Production) {
    for (const name of [
      'PAYMENT_KEY_SECRET',
      'PAYMENT_WEBHOOK_SECRET',
    ] as const) {
      const value = validated[name];
      if (
        !value ||
        value === DEV_PAYMENT_KEY_SECRET ||
        value === DEV_PAYMENT_WEBHOOK_SECRET
      ) {
        throw new Error(
          `Invalid environment configuration: set ${name} to this server's own secret in production.`,
        );
      }
    }
  }
  validated.PAYMENT_KEY_SECRET ??= DEV_PAYMENT_KEY_SECRET;
  validated.PAYMENT_WEBHOOK_SECRET ??= DEV_PAYMENT_WEBHOOK_SECRET;

  // Enquiries are emailed to the operations inbox. In production with a
  // provider that really sends, the reserved .test default would lose them
  // while the visitor is told they were received.
  if (
    validated.NODE_ENV === NodeEnv.Production &&
    validated.MESSAGING_PROVIDER !== 'sink' &&
    validated.OPERATIONS_INBOX_EMAIL.toLowerCase().endsWith('.test')
  ) {
    throw new Error(
      'Invalid environment configuration: set OPERATIONS_INBOX_EMAIL to the real operations inbox in production.',
    );
  }

  return validated;
}

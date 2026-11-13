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
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

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

  @IsString()
  @IsNotEmpty()
  DATABASE_URL: string;

  /** Origin of flyviman-web, allowed by CORS with credentials. */
  @IsString()
  @IsNotEmpty()
  WEB_ORIGIN: string = 'http://localhost:3000';

  /**
   * One-time codes, reset and invitation tokens, sign-in failure counts and
   * idempotency keys. (Rate-limit counters are in memory, per instance.)
   */
  @IsString()
  @IsNotEmpty()
  REDIS_URL: string = 'redis://localhost:6379';

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

  /** Requests per minute, per address, on each sign-in route. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  RATE_LIMIT_AUTH_PER_MINUTE: number = 5;

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
   * Where a new enquiry from the contact page is emailed: the operations
   * inbox. Deployments set the real address.
   */
  @IsEmail()
  OPERATIONS_INBOX_EMAIL: string = 'operations@flyviman.test';

  /**
   * Encrypts sensitive columns (identity document numbers). 32 random bytes,
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

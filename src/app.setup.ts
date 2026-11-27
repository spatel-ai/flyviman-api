import {
  BadRequestException,
  INestApplication,
  ValidationError,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import type { RequestHandler } from 'express';
import type { IncomingMessage } from 'node:http';
import * as helmetModule from 'helmet';
import { Logger } from 'nestjs-pino';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import {
  EnvelopeDto,
  ErrorEnvelopeDto,
  ResponseMetaDto,
} from './common/dto/envelope.dto.js';
import { ErrorDetail } from './common/errors/app.exception.js';
import { clientAddressMiddleware } from './common/middleware/client-address.middleware.js';
import { requestIdMiddleware } from './common/middleware/request-id.middleware.js';

type HelmetFactory = (options?: Record<string, unknown>) => RequestHandler;

/**
 * Helmet's middleware factory, however the import arrives. Helmet ships
 * separate ESM and CommonJS types; when an ES module is type-checked against
 * the CommonJS ones (as Vercel's build did), a default import is the whole
 * module object and `helmet()` fails with TS2349. Reading the namespace and
 * unwrapping `default` at runtime works under every resolution (D-062).
 */
function helmetFactory(value: unknown): HelmetFactory {
  let current = value;
  for (let depth = 0; depth < 2 && typeof current !== 'function'; depth += 1) {
    current = (current as { default?: unknown } | null)?.default;
  }
  if (typeof current !== 'function') {
    throw new Error('helmet did not export a middleware factory');
  }
  return current as HelmetFactory;
}

const helmet = helmetFactory(helmetModule);

export const API_PREFIX = 'api/v1';
export const DOCS_PATH = 'api/docs';

function toDetails(errors: ValidationError[], parent = ''): ErrorDetail[] {
  return errors.flatMap((error) => {
    const field = parent ? `${parent}.${error.property}` : error.property;
    const own = Object.values(error.constraints ?? {}).map((issue) => ({
      field,
      issue,
    }));
    return [...own, ...toDetails(error.children ?? [], field)];
  });
}

const PAYMENT_WEBHOOK_PATH = `/${API_PREFIX}/webhooks/payments/`;

/** Requests to `POST /webhooks/payments/:provider` (Express matches paths case-insensitively). */
function isPaymentWebhook(request: IncomingMessage): boolean {
  return (request.url ?? '').toLowerCase().startsWith(PAYMENT_WEBHOOK_PATH);
}

const OPENAPI_DESCRIPTION = [
  'Aviation booking platform API. Conventions: docs/api/api-design.md.',
  '',
  '**Envelope.** Every success is `{ data, meta }` (schema `EnvelopeDto`): each route below documents only its `data`. ' +
    '`meta` (`ResponseMetaDto`) holds `requestId`, and on list routes `page`, `pageSize` and `total`; ' +
    'a list route documented as an array answers with that array in `data`.',
  '',
  '**Errors.** Every error is `{ error: { code, message, details, requestId } }` (schema `ErrorEnvelopeDto`), ' +
    'with the HTTP status; clients switch on `code`.',
].join('\n');

export function buildOpenApiConfig() {
  return new DocumentBuilder()
    .setTitle('Flyviman API')
    .setDescription(OPENAPI_DESCRIPTION)
    .setVersion('1.0')
    .addCookieAuth('access_token')
    .build();
}

/** The OpenAPI document, for `/api/docs` and `npm run openapi:export` alike. */
export function createOpenApiDocument(app: INestApplication) {
  return SwaggerModule.createDocument(app, buildOpenApiConfig(), {
    extraModels: [EnvelopeDto, ResponseMetaDto, ErrorEnvelopeDto],
  });
}

/**
 * Applies the cross-cutting behaviour every request goes through. Kept apart
 * from `main.ts` so tests can build an identically configured application.
 */
export function configureApp(app: INestApplication): void {
  const config = app.get(ConfigService);

  app.useLogger(app.get(Logger));
  app.setGlobalPrefix(API_PREFIX);
  // Behind the load balancer in deployed environments, so `request.ip` is the
  // caller's address (rate limiting and audit records depend on it).
  // TRUST_PROXY_HOPS: 1 in production unless set, 0 elsewhere.
  const proxyHops = config.getOrThrow<number>('TRUST_PROXY_HOPS');
  if (proxyHops > 0) {
    (app as NestExpressApplication).set('trust proxy', proxyHops);
  }
  // Behind the web host's /api/v1 proxy, the visitor's address arrives in a
  // header signed with WEB_PROXY_SECRET; it is used only when it verifies.
  app.use(clientAddressMiddleware(config.get<string>('WEB_PROXY_SECRET')));
  app.use(requestIdMiddleware);
  // Webhook signatures are computed over the exact bytes sent, so payment
  // webhooks get the body unparsed, as a Buffer. Registered before Nest's
  // JSON parser, which then leaves these requests alone; every other route
  // is parsed as before.
  (app as NestExpressApplication).useBodyParser('raw', {
    type: isPaymentWebhook,
  });
  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({
    origin: config.getOrThrow<string>('WEB_ORIGIN'),
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: (errors) =>
        new BadRequestException({
          message: 'The request is not valid.',
          details: toDetails(errors),
        }),
    }),
  );
  app.enableShutdownHooks();

  // The interactive reference is for development; a production build does
  // not publish its route catalogue (security review, 2026-11-13). The
  // document itself is still exported by `npm run openapi:export`.
  if (config.get('NODE_ENV') !== 'production') {
    SwaggerModule.setup(DOCS_PATH, app, () => createOpenApiDocument(app));
  }
}

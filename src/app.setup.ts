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
import * as helmetModule from 'helmet';
import { Logger } from 'nestjs-pino';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ErrorDetail } from './common/errors/app.exception.js';
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

export function buildOpenApiConfig() {
  return new DocumentBuilder()
    .setTitle('Flyviman API')
    .setDescription(
      'Aviation booking platform API. Conventions: docs/api/api-design.md.',
    )
    .setVersion('1.0')
    .addCookieAuth('access_token')
    .build();
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
  if (config.get('NODE_ENV') === 'production') {
    (app as NestExpressApplication).set('trust proxy', 1);
  }
  app.use(requestIdMiddleware);
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
    const document = buildOpenApiConfig();
    SwaggerModule.setup(DOCS_PATH, app, () =>
      SwaggerModule.createDocument(app, document),
    );
  }
}

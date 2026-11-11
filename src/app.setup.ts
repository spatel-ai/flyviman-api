import {
  BadRequestException,
  INestApplication,
  ValidationError,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ErrorDetail } from './common/errors/app.exception.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { ResponseEnvelopeInterceptor } from './common/interceptors/response-envelope.interceptor.js';
import { requestIdMiddleware } from './common/middleware/request-id.middleware.js';

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

/**
 * Applies the cross-cutting behaviour every request goes through. Kept apart
 * from `main.ts` so tests can build an identically configured application.
 */
export function configureApp(app: INestApplication): void {
  const config = app.get(ConfigService);

  app.setGlobalPrefix(API_PREFIX);
  app.use(requestIdMiddleware);
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
  app.useGlobalInterceptors(new ResponseEnvelopeInterceptor());
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();

  const document = new DocumentBuilder()
    .setTitle('Flyviman API')
    .setDescription(
      'Aviation booking platform API. Conventions: docs/api/api-design.md.',
    )
    .setVersion('1.0')
    .addCookieAuth('access_token')
    .build();
  SwaggerModule.setup(DOCS_PATH, app, () =>
    SwaggerModule.createDocument(app, document),
  );
}

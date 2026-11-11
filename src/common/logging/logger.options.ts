import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ConfigService } from '@nestjs/config';
import type { Params } from 'nestjs-pino';

/**
 * Structured JSON logs with the request ID on every line. A request is
 * logged as method, path and status only: never its query string, headers,
 * cookies or body, which can hold personal, medical or payment data.
 */
export function loggerOptions(config: ConfigService): Params {
  const development = config.get('NODE_ENV') === 'development';
  return {
    pinoHttp: {
      level: config.getOrThrow<string>('LOG_LEVEL'),
      // Set by the request ID middleware, which runs first.
      genReqId: (request: IncomingMessage) => request.id ?? 'unknown',
      customProps: (request: IncomingMessage) => ({ requestId: request.id }),
      serializers: {
        req: (request: { method: string; url: string }) => ({
          method: request.method,
          path: request.url.split('?')[0],
        }),
        res: (response: { statusCode: number }) => ({
          statusCode: response.statusCode,
        }),
      },
      redact: {
        paths: [
          'req.headers',
          'res.headers',
          '*.password',
          '*.passwordHash',
          '*.token',
          '*.refreshToken',
          '*.accessToken',
        ],
        remove: true,
      },
      customLogLevel: (
        _request: IncomingMessage,
        response: ServerResponse,
        error?: Error,
      ) => {
        if (error || response.statusCode >= 500) return 'error';
        if (response.statusCode >= 400) return 'warn';
        return 'info';
      },
      transport: development
        ? { target: 'pino-pretty', options: { singleLine: true } }
        : undefined,
    },
  };
}

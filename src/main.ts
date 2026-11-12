import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import type { Redis } from 'ioredis';
import { API_PREFIX, configureApp, DOCS_PATH } from './app.setup.js';
import { PrismaService } from './prisma/prisma.service.js';
import { REDIS } from './redis/redis.module.js';

const CONNECT_TIMEOUT_MS = 10_000;

async function reachable(what: string, probe: () => Promise<unknown>) {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      probe(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('timed out')),
          CONNECT_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (error) {
    const reason = error instanceof Error ? error.name : 'unknown error';
    throw new Error(
      `Cannot reach ${what}: ${reason}. Check the variable and that the service is in the same region and running.`,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  configureApp(app);

  const config = app.get(ConfigService);
  const port = config.getOrThrow<number>('PORT');

  // Fail at start, with a clear reason, if the database or Redis cannot be
  // reached, rather than on the first sign-in (D-065). Messages name the
  // variable, never its value.
  await reachable(
    'PostgreSQL (DATABASE_URL)',
    () => app.get(PrismaService).$queryRaw`SELECT 1`,
  );
  await reachable('Redis (REDIS_URL)', () => app.get<Redis>(REDIS).ping());

  await app.listen(port);

  const logger = new Logger('Bootstrap');
  // A proof-of-concept host must not be mistaken for production (D-064).
  if (config.get<string>('MESSAGING_PROVIDER') === 'sink') {
    logger.warn(
      'PROOF OF CONCEPT: messages are discarded (MESSAGING_PROVIDER=sink). Sign-up and password-reset codes never arrive. Not for production.',
    );
  }
  if (config.get<string>('STORAGE_PROVIDER') === 'local') {
    logger.warn(
      "PROOF OF CONCEPT: uploads are kept unencrypted on this server's disk (STORAGE_PROVIDER=local) and lost when it is wiped. Use demo documents only. Not for production.",
    );
  }
  logger.log(`API listening on http://localhost:${port}/${API_PREFIX}`);
  logger.log(`API reference at http://localhost:${port}/${DOCS_PATH}`);
}
await bootstrap();

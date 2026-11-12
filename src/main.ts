import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { API_PREFIX, configureApp, DOCS_PATH } from './app.setup.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  configureApp(app);

  const config = app.get(ConfigService);
  const port = config.getOrThrow<number>('PORT');
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

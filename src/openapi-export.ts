import { writeFile } from 'node:fs/promises';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { API_PREFIX, createOpenApiDocument } from './app.setup.js';

/**
 * Writes the API description to `openapi.json`, which flyviman-web turns
 * into TypeScript types. Needs neither the database nor Redis to be running.
 *
 *   npm run openapi:export
 */
const app = await NestFactory.create(AppModule, { logger: false });
app.setGlobalPrefix(API_PREFIX);
const document = createOpenApiDocument(app);
await writeFile('openapi.json', `${JSON.stringify(document, null, 2)}\n`);
await app.close();
console.log('Wrote openapi.json');

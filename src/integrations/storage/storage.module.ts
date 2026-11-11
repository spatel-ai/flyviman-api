import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MockStorageController } from './mock-storage.controller.js';
import { MockStorageProvider } from './mock-storage.provider.js';
import { StorageProvider } from './storage.provider.js';

/**
 * Binds StorageProvider to an implementation. Only the local-disk mock
 * exists; an S3-compatible provider must be added before production, and the API
 * refuses to start without one unless ENABLE_DEV_TOOLS is on.
 */
@Module({
  // Registered always; DevToolsGuard answers 404 unless ENABLE_DEV_TOOLS is on.
  controllers: [MockStorageController],
  providers: [
    MockStorageProvider,
    {
      provide: StorageProvider,
      inject: [MockStorageProvider, ConfigService],
      useFactory: (mock: MockStorageProvider, config: ConfigService) => {
        if (!config.get<boolean>('ENABLE_DEV_TOOLS')) {
          throw new Error(
            'No storage provider is configured for this environment. Set ENABLE_DEV_TOOLS=true to use the mock outside production. See src/integrations/README.md.',
          );
        }
        return mock;
      },
    },
  ],
  exports: [StorageProvider],
})
export class StorageModule {}

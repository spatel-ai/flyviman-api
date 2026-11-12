import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MockStorageController } from './mock-storage.controller.js';
import { MockStorageProvider } from './mock-storage.provider.js';
import { StorageProvider } from './storage.provider.js';

/**
 * Binds StorageProvider to an implementation, chosen by STORAGE_PROVIDER:
 * `mock` (development, needs ENABLE_DEV_TOOLS) or `local` (the same signed
 * local-disk store for a proof of concept). An S3-compatible provider is
 * still needed before files must survive a redeploy.
 */
@Module({
  // Registered always; LocalStorageGuard answers 404 unless local storage is in use.
  controllers: [MockStorageController],
  providers: [
    MockStorageProvider,
    {
      provide: StorageProvider,
      inject: [MockStorageProvider, ConfigService],
      useFactory: (mock: MockStorageProvider, config: ConfigService) => {
        if (
          config.get<string>('STORAGE_PROVIDER') !== 'local' &&
          !config.get<boolean>('ENABLE_DEV_TOOLS')
        ) {
          throw new Error(
            'No storage provider is configured for this environment. Set STORAGE_PROVIDER=local (with API_PUBLIC_URL) for a proof of concept, or ENABLE_DEV_TOOLS=true on a developer machine. See src/integrations/README.md.',
          );
        }
        return mock;
      },
    },
  ],
  exports: [StorageProvider],
})
export class StorageModule {}

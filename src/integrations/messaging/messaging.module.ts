import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MessagingProvider } from './messaging.provider.js';
import { MockMessagingProvider } from './mock-messaging.provider.js';
import { MockOutboxController } from './mock-outbox.controller.js';

/**
 * Binds MessagingProvider to an implementation. Only the mock exists; a real
 * provider must be added before production, and the API refuses to start without one unless ENABLE_DEV_TOOLS is on.
 */
@Module({
  // Registered always; DevToolsGuard answers 404 unless ENABLE_DEV_TOOLS is on.
  controllers: [MockOutboxController],
  providers: [
    MockMessagingProvider,
    {
      provide: MessagingProvider,
      inject: [MockMessagingProvider, ConfigService],
      useFactory: (mock: MockMessagingProvider, config: ConfigService) => {
        if (!config.get<boolean>('ENABLE_DEV_TOOLS')) {
          throw new Error(
            'No messaging provider is configured for this environment. Set ENABLE_DEV_TOOLS=true to use the mock outside production. See src/integrations/README.md.',
          );
        }
        return mock;
      },
    },
  ],
  exports: [MessagingProvider],
})
export class MessagingModule {}

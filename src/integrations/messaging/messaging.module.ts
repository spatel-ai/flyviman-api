import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MessagingProvider } from './messaging.provider.js';
import { MockMessagingProvider } from './mock-messaging.provider.js';
import { MockOutboxController } from './mock-outbox.controller.js';
import { SinkMessagingProvider } from './sink-messaging.provider.js';

/**
 * Binds MessagingProvider to an implementation, chosen by MESSAGING_PROVIDER:
 * `mock` (development outbox, needs ENABLE_DEV_TOOLS) or `sink` (discards
 * everything, for a shared server without a provider). A real provider is
 * still needed before people can register or reset passwords.
 */
@Module({
  // Registered always; DevToolsGuard answers 404 unless ENABLE_DEV_TOOLS is on.
  controllers: [MockOutboxController],
  providers: [
    MockMessagingProvider,
    SinkMessagingProvider,
    {
      provide: MessagingProvider,
      inject: [MockMessagingProvider, SinkMessagingProvider, ConfigService],
      useFactory: (
        mock: MockMessagingProvider,
        sink: SinkMessagingProvider,
        config: ConfigService,
      ) => {
        if (config.get<string>('MESSAGING_PROVIDER') === 'sink') return sink;
        if (!config.get<boolean>('ENABLE_DEV_TOOLS')) {
          throw new Error(
            'No messaging provider is configured for this environment. Set MESSAGING_PROVIDER=sink to run without one (messages are discarded), or ENABLE_DEV_TOOLS=true on a developer machine. See src/integrations/README.md.',
          );
        }
        return mock;
      },
    },
  ],
  exports: [MessagingProvider],
})
export class MessagingModule {}

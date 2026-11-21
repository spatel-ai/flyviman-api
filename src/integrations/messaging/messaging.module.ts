import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MessagingProvider } from './messaging.provider.js';
import { MockMessagingProvider } from './mock-messaging.provider.js';
import { MockOutboxController } from './mock-outbox.controller.js';
import { SinkMessagingProvider } from './sink-messaging.provider.js';
import {
  createSmtpTransport,
  SmtpMessagingProvider,
} from './smtp-messaging.provider.js';

/**
 * Binds MessagingProvider to an implementation, chosen by MESSAGING_PROVIDER:
 * `mock` (development outbox, needs ENABLE_DEV_TOOLS), `sink` (discards
 * everything, for a shared server without a provider) or `smtp` (email by
 * SMTP; SMS and WhatsApp still have no provider).
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
        const provider = config.get<string>('MESSAGING_PROVIDER');
        if (provider === 'sink') return sink;
        if (provider === 'smtp') {
          return new SmtpMessagingProvider(
            createSmtpTransport(config),
            {
              from: {
                name: config.get<string>('EMAIL_FROM_NAME') ?? 'Flyviman',
                address: config.get<string>('USER_EMAIL') ?? '',
              },
              redirectTo: config.get<string>('EMAIL_REDIRECT_TO'),
              devOutbox: config.get<boolean>('ENABLE_DEV_TOOLS') === true,
            },
            mock,
            sink,
          );
        }
        if (!config.get<boolean>('ENABLE_DEV_TOOLS')) {
          throw new Error(
            'No messaging provider is configured for this environment. Set MESSAGING_PROVIDER=smtp to send email by SMTP, MESSAGING_PROVIDER=sink to run without one (messages are discarded), or ENABLE_DEV_TOOLS=true on a developer machine. See src/integrations/README.md.',
          );
        }
        return mock;
      },
    },
  ],
  exports: [MessagingProvider],
})
export class MessagingModule {}

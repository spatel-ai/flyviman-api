import { randomBytes } from 'node:crypto';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MockPaymentGatewayProvider } from './mock-payment-gateway.provider.js';
import { PaymentGatewayProvider } from './payment-gateway.provider.js';

/**
 * Binds PaymentGatewayProvider to an implementation, chosen by
 * PAYMENT_PROVIDER. Only `mock` exists: real payments must not be possible
 * until the commercial decisions are settled (docs/open-decisions.md, Hard
 * gate). Razorpay will be one more adapter bound here.
 */
@Module({
  providers: [
    {
      provide: PaymentGatewayProvider,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        // Configuration validation refuses anything else; checked again here
        // so a gap there can never reach a real gateway.
        if (config.get<string>('PAYMENT_PROVIDER') !== 'mock') {
          throw new Error(
            'Only the mock payment gateway exists in this build (PAYMENT_PROVIDER=mock).',
          );
        }
        // Secrets from the validated configuration (defaults outside
        // production); never logged.
        return new MockPaymentGatewayProvider({
          keySecret: config.getOrThrow<string>('PAYMENT_KEY_SECRET'),
          webhookSecret: config.getOrThrow<string>('PAYMENT_WEBHOOK_SECRET'),
          runId: randomBytes(4).toString('hex'),
        });
      },
    },
  ],
  exports: [PaymentGatewayProvider],
})
export class PaymentModule {}

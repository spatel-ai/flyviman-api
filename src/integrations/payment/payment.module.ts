import { randomBytes } from 'node:crypto';
import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MockPaymentGatewayProvider } from './mock-payment-gateway.provider.js';
import { MockPaymentController } from './mock-payment.controller.js';
import { PaymentGatewayProvider } from './payment-gateway.provider.js';
import { RazorpayPaymentGatewayProvider } from './razorpay-payment-gateway.provider.js';

/**
 * Binds PaymentGatewayProvider to an implementation, chosen by
 * PAYMENT_PROVIDER: `mock` (default, every test; moves no money) or
 * `razorpay`. Payments must not go live until the commercial decisions are
 * settled (docs/open-decisions.md, Hard gate). The mock's development route
 * (`dev/payments`) needs ENABLE_DEV_TOOLS and answers 404 with Razorpay.
 */
@Module({
  controllers: [MockPaymentController],
  providers: [
    {
      provide: PaymentGatewayProvider,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const provider = config.get<string>('PAYMENT_PROVIDER');
        // Secrets from the validated configuration; never logged.
        if (provider === 'razorpay') {
          const webhookSecret = config.get<string>('RAZORPAY_WEBHOOK_SECRET');
          if (!webhookSecret) {
            new Logger('PaymentModule').warn(
              'RAZORPAY_WEBHOOK_SECRET is not set: Razorpay webhooks are refused; payments settle through the status sweep and refunds wait for their notices.',
            );
          }
          return new RazorpayPaymentGatewayProvider({
            keyId: config.getOrThrow<string>('RAZORPAY_KEY_ID'),
            keySecret: config.getOrThrow<string>('RAZORPAY_KEY_SECRET'),
            webhookSecret,
          });
        }
        // Configuration validation refuses anything else; checked again here
        // so a gap there can never pick a gateway by accident.
        if (provider !== 'mock') {
          throw new Error('PAYMENT_PROVIDER must be mock or razorpay.');
        }
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

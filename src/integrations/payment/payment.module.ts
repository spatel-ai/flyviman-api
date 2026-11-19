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
    MockPaymentGatewayProvider,
    {
      provide: PaymentGatewayProvider,
      inject: [MockPaymentGatewayProvider, ConfigService],
      useFactory: (mock: MockPaymentGatewayProvider, config: ConfigService) => {
        // Configuration validation refuses anything else; checked again here
        // so a gap there can never reach a real gateway.
        if (config.get<string>('PAYMENT_PROVIDER') !== 'mock') {
          throw new Error(
            'Only the mock payment gateway exists in this build (PAYMENT_PROVIDER=mock).',
          );
        }
        return mock;
      },
    },
  ],
  exports: [PaymentGatewayProvider],
})
export class PaymentModule {}

import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AirlineInventoryProvider } from './airline.provider.js';
import { MockAirlineProvider } from './mock-airline.provider.js';

/**
 * Binds AirlineInventoryProvider to an implementation, chosen by
 * AIRLINE_PROVIDER. Only `mock` exists: it is pure and makes no network
 * call, so it needs no development tools. To add a supplier, write its
 * adapter, add its value to AIRLINE_PROVIDER in env.validation.ts and add a
 * branch here.
 */
@Module({
  providers: [
    {
      provide: AirlineInventoryProvider,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const name = config.get<string>('AIRLINE_PROVIDER') ?? 'mock';
        if (name === 'mock') return new MockAirlineProvider();
        throw new Error(`Unknown AIRLINE_PROVIDER: ${name}.`);
      },
    },
  ],
  exports: [AirlineInventoryProvider],
})
export class AirlineModule {}

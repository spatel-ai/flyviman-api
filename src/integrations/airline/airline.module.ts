import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AIRLINE_PROVIDERS,
  AirlineInventoryProvider,
  type NamedAirlineProvider,
} from './airline.provider.js';
import { MockAirlineController } from './mock-airline.controller.js';
import { MockAirlineProvider } from './mock-airline.provider.js';

/**
 * Binds AirlineInventoryProvider to an implementation, chosen by
 * AIRLINE_PROVIDER. Only `mock` exists: it is pure and makes no network
 * call, so it needs no development tools. To add a supplier, write its
 * adapter, add its value to AIRLINE_PROVIDER in env.validation.ts and add a
 * branch here.
 *
 * AIRLINE_PROVIDERS lists every configured supplier by name for scheduled
 * search, which calls them in parallel. Today it holds the one above.
 */
@Module({
  // Registered always; DevToolsGuard answers 404 unless ENABLE_DEV_TOOLS is on.
  controllers: [MockAirlineController],
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
    {
      provide: AIRLINE_PROVIDERS,
      inject: [AirlineInventoryProvider, ConfigService],
      useFactory: (
        provider: AirlineInventoryProvider,
        config: ConfigService,
      ): NamedAirlineProvider[] => [
        { name: config.get<string>('AIRLINE_PROVIDER') ?? 'mock', provider },
      ],
    },
  ],
  exports: [AirlineInventoryProvider, AIRLINE_PROVIDERS],
})
export class AirlineModule {}

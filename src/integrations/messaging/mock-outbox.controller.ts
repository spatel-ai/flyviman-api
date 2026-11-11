import { Controller, UseGuards, Get, Query } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { DevToolsGuard } from '../dev-tools.guard.js';
import { Public } from '../../modules/auth/auth.decorators.js';
import {
  MockMessage,
  MockMessagingProvider,
} from './mock-messaging.provider.js';

/**
 * Development and test only: shows what the messaging mock "sent". It is
 * answered only when ENABLE_DEV_TOOLS is on, which the
 * configuration refuses in production (see DevToolsGuard).
 */
@ApiExcludeController()
@UseGuards(DevToolsGuard)
@Public()
@Controller('dev/outbox')
export class MockOutboxController {
  constructor(private readonly provider: MockMessagingProvider) {}

  @Get()
  list(@Query('to') to: string): MockMessage[] {
    return typeof to === 'string' ? this.provider.messagesTo(to) : [];
  }
}

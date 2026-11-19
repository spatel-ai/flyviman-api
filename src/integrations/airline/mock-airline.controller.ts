import {
  Body,
  Controller,
  HttpCode,
  NotFoundException,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { IsIn, Matches } from 'class-validator';
import { Public } from '../../modules/auth/auth.decorators.js';
import { DevToolsGuard } from '../dev-tools.guard.js';
import { AirlineInventoryProvider } from './airline.provider.js';
import {
  MockAirlineProvider,
  type MockAirlineBehaviour,
} from './mock-airline.provider.js';

const IATA = /^[A-Za-z]{3}$/;

export class MockAirlineBehaviourDto {
  @Matches(IATA)
  origin: string;

  @Matches(IATA)
  destination: string;

  @IsIn(['NORMAL', 'TIMEOUT', 'ERROR'])
  behaviour: MockAirlineBehaviour;
}

/**
 * Development and test only: makes the airline mock time out or fail on
 * one route, so partial scheduled results can be exercised. Answered only
 * when ENABLE_DEV_TOOLS is on, which production refuses (DevToolsGuard).
 */
@ApiExcludeController()
@UseGuards(DevToolsGuard)
@Public()
@Controller('dev/airline')
export class MockAirlineController {
  constructor(private readonly provider: AirlineInventoryProvider) {}

  @Put('behaviour')
  @HttpCode(204)
  set(@Body() dto: MockAirlineBehaviourDto): void {
    if (!(this.provider instanceof MockAirlineProvider)) {
      throw new NotFoundException();
    }
    this.provider.simulate(dto.origin, dto.destination, dto.behaviour);
  }
}

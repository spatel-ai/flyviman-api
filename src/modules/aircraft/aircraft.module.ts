import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module.js';
import { OperatorsModule } from '../operators/operators.module.js';
import { AircraftService } from './aircraft.service.js';
import { OperatorAircraftController } from './operator-aircraft.controller.js';

@Module({
  imports: [OperatorsModule, DocumentsModule],
  controllers: [OperatorAircraftController],
  providers: [AircraftService],
  exports: [AircraftService],
})
export class AircraftModule {}

import { Module } from '@nestjs/common';
import { FieldCipher } from '../../common/crypto/field-cipher.js';
import { OperatorsModule } from '../operators/operators.module.js';
import { AirAmbulanceService } from './air-ambulance.service.js';

/** Owns AirAmbulanceRequest, AirAmbulanceMedical, its timeline and documents. */
@Module({
  imports: [OperatorsModule],
  providers: [AirAmbulanceService, FieldCipher],
  exports: [AirAmbulanceService],
})
export class AirAmbulanceModule {}

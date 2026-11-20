import { ApiProperty } from '@nestjs/swagger';
import { AirAmbulanceStatus } from '../../../generated/prisma/enums.js';
import {
  AirAmbulanceTimelineEntryDto,
  EMERGENCY_NOTICE,
  MedicalDetailsDto,
} from './air-ambulance.dto.js';

/**
 * A mission in the selected operator's list (W4-6). Never any medical,
 * contact or price data: the list is for finding a mission.
 */
export class OperatorAirAmbulanceSummaryDto {
  @ApiProperty({ example: 'FLY-AA-7K2M9Q' })
  reference: string;

  @ApiProperty({ enum: AirAmbulanceStatus, enumName: 'AirAmbulanceStatus' })
  status: AirAmbulanceStatus;

  @ApiProperty({ nullable: true, type: String })
  originName: string | null;

  @ApiProperty({ nullable: true, type: String })
  destinationName: string | null;

  @ApiProperty({ format: 'date-time' })
  preferredAt: string;

  @ApiProperty()
  patientCount: number;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;
}

/**
 * One mission as the selected operator's administrator sees it (W4-6): the
 * route, the places and the medical details (each read audited), with the
 * status-only timeline. No customer contact details and no quotation amount:
 * operations coordinate with the customer and agree the price with the
 * operator themselves.
 */
export class OperatorAirAmbulanceRequestDto extends OperatorAirAmbulanceSummaryDto {
  @ApiProperty({ nullable: true, type: String, description: 'Decrypted.' })
  pickupAddress: string | null;

  @ApiProperty({ nullable: true, type: String, description: 'Decrypted.' })
  destinationFacility: string | null;

  @ApiProperty()
  accompanyingPersons: number;

  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  confirmedAt: string | null;

  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  completedAt: string | null;

  @ApiProperty({
    type: MedicalDetailsDto,
    nullable: true,
    description:
      'Every read is audited (`air_ambulance_request.medical_read`). Null only if the details are missing.',
  })
  medical: MedicalDetailsDto | null;

  @ApiProperty({ type: [AirAmbulanceTimelineEntryDto] })
  timeline: AirAmbulanceTimelineEntryDto[];

  @ApiProperty({ example: EMERGENCY_NOTICE })
  emergencyNotice: string;
}

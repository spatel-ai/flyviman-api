import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { AirAmbulanceStatus } from '../../generated/prisma/enums.js';
import { CLOSED } from './air-ambulance-transitions.js';

/** A request's status and timestamps only: never contact or medical data. */
export interface AirAmbulanceReportRow {
  status: AirAmbulanceStatus;
  createdAt: Date;
  quotedAt: Date | null;
  confirmedAt: Date | null;
}

/**
 * Counts and timings of air ambulance requests for the reports module
 * (W5-1). Reads only status and timestamps from `AirAmbulanceRequest`;
 * never `AirAmbulanceMedical`, addresses, contacts or event payloads
 * (rule 8).
 */
@Injectable()
export class AirAmbulanceReportsService {
  constructor(private readonly prisma: PrismaService) {}

  openCount(): Promise<number> {
    return this.prisma.airAmbulanceRequest.count({
      where: { status: { notIn: [...CLOSED] } },
    });
  }

  rows(createdAt: { gte: Date; lt: Date }): Promise<AirAmbulanceReportRow[]> {
    return this.prisma.airAmbulanceRequest.findMany({
      where: { createdAt },
      select: {
        status: true,
        createdAt: true,
        quotedAt: true,
        confirmedAt: true,
      },
    });
  }

  count(createdAt: { gte: Date; lt: Date }): Promise<number> {
    return this.prisma.airAmbulanceRequest.count({ where: { createdAt } });
  }
}

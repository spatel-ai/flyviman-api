import { Injectable } from '@nestjs/common';
import type { Aircraft } from '../../generated/prisma/client.js';
import type { AircraftCategory } from '../../generated/prisma/enums.js';
import { RoutingProvider } from '../../integrations/routing/routing.provider.js';
import { searchBlockers } from '../aircraft/aircraft-search.js';
import { AircraftService } from '../aircraft/aircraft.service.js';
import { AvailabilityService } from '../availability/availability.service.js';
import { LocationsService } from '../locations/locations.service.js';
import { OperatorsService } from '../operators/operators.service.js';
import type { PricePoint } from '../pricing/engine.js';
import { legMetrics } from '../pricing/engine.js';
import {
  resolveRules,
  type ResolvedRules,
  type RuleRow,
} from '../pricing/rules.js';
import { staticChecks, type ExclusionReason } from './criteria.js';

export interface MatchRequest {
  categories: AircraftCategory[];
  origin: PricePoint;
  destination: PricePoint;
  departureAt: Date;
  passengerCount: number;
  rules: RuleRow[];
  now: Date;
}

export interface Candidate {
  aircraft: Aircraft;
  operatorName: string;
  base: PricePoint | null;
  rules: ResolvedRules;
}

export interface MatchResult {
  candidates: Candidate[];
  exclusions: { aircraftId: string; reasons: ExclusionReason[] }[];
}

/**
 * Which aircraft can fly this trip (pricing-engine.md, step 3). Only
 * approved inventory (business rule 4): listing and operator approved, in
 * service, required documents current. Then seats, range, positioning and
 * the operator's offered time.
 */
@Injectable()
export class MatchingService {
  constructor(
    private readonly aircraft: AircraftService,
    private readonly operators: OperatorsService,
    private readonly locations: LocationsService,
    private readonly availability: AvailabilityService,
    private readonly routing: RoutingProvider,
  ) {}

  async match(request: MatchRequest): Promise<MatchResult> {
    const rows = await this.aircraft.searchCandidates({
      categories: request.categories,
      minPassengers: request.passengerCount,
      minRangeKm: this.routing.distanceKm(request.origin, request.destination),
    });
    const operatorNames = await this.operators.approvedNames([
      ...new Set(rows.map((row) => row.operatorId)),
    ]);
    const baseIds = rows.flatMap((row) => {
      const id = row.currentLocationId ?? row.homeBaseId;
      return id ? [id] : [];
    });
    const bases = await this.locations.pricingPoints([...new Set(baseIds)]);
    const distance = (a: PricePoint, b: PricePoint) =>
      this.routing.distanceKm(a, b);

    const candidates: Candidate[] = [];
    const exclusions: MatchResult['exclusions'] = [];

    for (const row of rows) {
      const operatorName = operatorNames.get(row.operatorId);
      const reasons: ExclusionReason[] = searchBlockers({
        listingStatus: row.listingStatus,
        availabilityStatus: row.availabilityStatus,
        operatorStatus: operatorName ? 'APPROVED' : 'SUSPENDED',
        missing: row.missing,
      });
      const baseId = row.currentLocationId ?? row.homeBaseId;
      const base = (baseId && bases.get(baseId)) || null;
      if (!base) reasons.push('location');

      const rules = resolveRules(request.rules, {
        aircraftId: row.id,
        operatorId: row.operatorId,
        category: row.category,
      });
      const leg = legMetrics(
        rules,
        distance(request.origin, request.destination),
        row.cruiseSpeedKmh,
      );
      const out =
        base && base.id !== request.origin.id
          ? legMetrics(
              rules,
              distance(base, request.origin),
              row.cruiseSpeedKmh,
            )
          : { minutes: 0 };
      reasons.push(
        ...staticChecks({
          passengerCapacity: row.passengerCapacity,
          passengerCount: request.passengerCount,
          rangeKm: row.rangeKm,
          distanceKm: leg.distanceKm,
          positioningMinutes: out.minutes ?? 0,
          departureAt: request.departureAt,
          now: request.now,
        }),
      );

      if (reasons.length === 0) {
        // The aircraft is busy from leaving base to landing at the destination.
        const from = new Date(
          request.departureAt.getTime() - (out.minutes ?? 0) * 60_000,
        );
        const to = new Date(
          request.departureAt.getTime() + (leg.minutes ?? 60) * 60_000,
        );
        const state = await this.availability.windowState(
          row.id,
          from,
          to,
          request.origin.id,
        );
        if (!state.covered || state.blocked) reasons.push('availability');
      }

      if (reasons.length > 0) {
        exclusions.push({ aircraftId: row.id, reasons });
      } else {
        candidates.push({
          aircraft: row,
          operatorName: operatorName!,
          base,
          rules,
        });
      }
    }
    return { candidates, exclusions };
  }
}

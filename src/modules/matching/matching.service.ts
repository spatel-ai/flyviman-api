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
import {
  staticChecks,
  windowFree,
  type AircraftWindows,
  type ExclusionReason,
} from './criteria.js';

export interface MatchRoute {
  categories: AircraftCategory[];
  origin: PricePoint;
  destination: PricePoint;
  passengerCount: number;
  rules: RuleRow[];
}

export interface Candidate {
  aircraft: Aircraft;
  operatorName: string;
  base: PricePoint | null;
  rules: ResolvedRules;
  /** The leg and the positioning to it, for this aircraft. */
  legMinutes: number | null;
  positioningMinutes: number;
}

export interface MatchResult {
  candidates: Candidate[];
  exclusions: { aircraftId: string; reasons: ExclusionReason[] }[];
}

/** Everything about a route that does not depend on the departure time. */
export interface PreparedRoute {
  route: MatchRoute;
  /** Aircraft that pass every check except time, with their windows. */
  ready: (Candidate & {
    windows: AircraftWindows | undefined;
    rangeKm: number | null;
    distanceKm: number;
  })[];
  /** Left out whatever the date. */
  excluded: MatchResult['exclusions'];
}

/**
 * Which aircraft can fly this trip (pricing-engine.md, step 3). Only
 * approved inventory (business rule 4): listing and operator approved, in
 * service, required documents current. Then seats, range, positioning and
 * the operator's offered time. `prepare` does every database read once;
 * `evaluate` applies a departure time, so a month of days costs one load.
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

  async match(
    route: MatchRoute,
    departureAt: Date,
    now: Date,
  ): Promise<MatchResult> {
    const prepared = await this.prepare(route, departureAt, departureAt);
    return this.evaluate(prepared, departureAt, now);
  }

  /** Loads the aircraft and their offered time for departures in [from, to]. */
  async prepare(
    route: MatchRoute,
    firstDeparture: Date,
    lastDeparture: Date,
  ): Promise<PreparedRoute> {
    const distance = (a: PricePoint, b: PricePoint) =>
      this.routing.distanceKm(a, b);
    const rows = await this.aircraft.searchCandidates({
      categories: route.categories,
      minPassengers: route.passengerCount,
      minRangeKm: distance(route.origin, route.destination),
    });
    const operatorNames = await this.operators.approvedNames([
      ...new Set(rows.map((row) => row.operatorId)),
    ]);
    const baseIds = rows.flatMap((row) => {
      const id = row.currentLocationId ?? row.homeBaseId;
      return id ? [id] : [];
    });
    const bases = await this.locations.pricingPoints([...new Set(baseIds)]);

    const ready: PreparedRoute['ready'] = [];
    const excluded: PreparedRoute['excluded'] = [];
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
      if (reasons.length > 0) {
        excluded.push({ aircraftId: row.id, reasons });
        continue;
      }
      const rules = resolveRules(route.rules, {
        aircraftId: row.id,
        operatorId: row.operatorId,
        category: row.category,
      });
      const leg = legMetrics(
        rules,
        distance(route.origin, route.destination),
        row.cruiseSpeedKmh,
      );
      const out =
        base && base.id !== route.origin.id
          ? legMetrics(rules, distance(base, route.origin), row.cruiseSpeedKmh)
          : { minutes: 0 };
      ready.push({
        aircraft: row,
        operatorName: operatorName!,
        base,
        rules,
        legMinutes: leg.minutes,
        positioningMinutes: out.minutes ?? 0,
        rangeKm: row.rangeKm,
        distanceKm: leg.distanceKm,
        windows: undefined,
      });
    }

    // One read of offered time for every aircraft, covering every departure.
    const longest = Math.max(
      0,
      ...ready.map((r) => r.positioningMinutes + (r.legMinutes ?? 60)),
    );
    const windows = await this.availability.windowsFor(
      ready.map((r) => r.aircraft.id),
      new Date(firstDeparture.getTime() - longest * 60_000),
      new Date(lastDeparture.getTime() + longest * 60_000),
    );
    for (const entry of ready) {
      entry.windows = windows.get(entry.aircraft.id) as
        AircraftWindows | undefined;
    }
    return { route, ready, excluded };
  }

  /** The aircraft that can fly at this departure time. No database access. */
  evaluate(prepared: PreparedRoute, departureAt: Date, now: Date): MatchResult {
    const candidates: Candidate[] = [];
    const exclusions = [...prepared.excluded];
    for (const entry of prepared.ready) {
      const reasons = staticChecks({
        passengerCapacity: entry.aircraft.passengerCapacity,
        passengerCount: prepared.route.passengerCount,
        rangeKm: entry.rangeKm,
        distanceKm: entry.distanceKm,
        positioningMinutes: entry.positioningMinutes,
        departureAt,
        now,
      });
      if (reasons.length === 0) {
        // Busy from leaving base to landing at the destination.
        const from = new Date(
          departureAt.getTime() - entry.positioningMinutes * 60_000,
        );
        const to = new Date(
          departureAt.getTime() + (entry.legMinutes ?? 60) * 60_000,
        );
        if (!windowFree(entry.windows, from, to, prepared.route.origin.id)) {
          reasons.push('availability');
        }
      }
      if (reasons.length > 0) {
        exclusions.push({ aircraftId: entry.aircraft.id, reasons });
      } else {
        const {
          windows: _w,
          rangeKm: _r,
          distanceKm: _d,
          ...candidate
        } = entry;
        candidates.push(candidate);
      }
    }
    return { candidates, exclusions };
  }
}

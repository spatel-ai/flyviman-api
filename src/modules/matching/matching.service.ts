import { Injectable } from '@nestjs/common';
import type { Aircraft } from '../../generated/prisma/client.js';
import type { AircraftCategory } from '../../generated/prisma/enums.js';
import { parseRestrictions } from '../../common/restrictions/restrictions.js';
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
  combineRestrictions,
  legTimeChecks,
  limitsFor,
  localMinutes,
  routeChecks,
  staticChecks,
  timeChecks,
  tripLimitIssue,
  windowFree,
  type AircraftWindows,
  type CombinedRestrictions,
  type ExclusionReason,
  type LocalTime,
  type MatchingLimits,
  type MatchPoint,
} from './criteria.js';

export interface MatchRoute {
  categories: AircraftCategory[];
  origin: PricePoint & MatchPoint;
  destination: PricePoint & MatchPoint;
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
  /** For the customer: what the operator still has to confirm. */
  warnings: string[];
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
    limits: MatchingLimits;
    restrictions: CombinedRestrictions;
  })[];
  /** Left out whatever the date. */
  excluded: MatchResult['exclusions'];
}

/**
 * Which aircraft can fly this trip (pricing-engine.md, step 3). Only
 * approved inventory (business rule 4): listing and operator approved, in
 * service, required documents current. Then seats, range, positioning,
 * the operator's offered time, the locations at both ends, Flyviman's
 * limits and the operator's and aircraft's restrictions (stricter wins). `prepare` does every database read once;
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

  /**
   * The trip-wide notice or leg-length limit every searched category fails,
   * or `null` (pricing-engine.md, step 1). See `tripLimitIssue` in criteria.
   */
  tripLimitIssue(
    input: Parameters<typeof tripLimitIssue>[0],
  ): ReturnType<typeof tripLimitIssue> {
    return tripLimitIssue(input);
  }

  /** `returnAt`: a round trip's return departure from the destination. */
  async match(
    route: MatchRoute,
    departureAt: Date,
    now: Date,
    returnAt: Date | null = null,
  ): Promise<MatchResult> {
    const prepared = await this.prepare(
      route,
      departureAt,
      returnAt ?? departureAt,
    );
    return this.evaluate(prepared, departureAt, now, returnAt);
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
    const operators = await this.operators.approvedForMatching([
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
      const operator = operators.get(row.operatorId);
      const reasons: ExclusionReason[] = searchBlockers({
        listingStatus: row.listingStatus,
        availabilityStatus: row.availabilityStatus,
        operatorStatus: operator ? 'APPROVED' : 'SUSPENDED',
        missing: row.missing,
      });
      const baseId = row.currentLocationId ?? row.homeBaseId;
      const base = (baseId && bases.get(baseId)) || null;
      if (!base) reasons.push('location');
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
      const limits = limitsFor(route.rules, row.category);
      const restrictions = combineRestrictions(
        parseRestrictions(operator?.restrictions),
        parseRestrictions(row.restrictions),
      );
      const fit = routeChecks({
        wingType: row.wingType,
        distanceKm: leg.distanceKm,
        origin: route.origin,
        destination: route.destination,
        limits,
        restrictions,
      });
      reasons.push(...fit.reasons);
      if (reasons.length > 0) {
        excluded.push({ aircraftId: row.id, reasons });
        continue;
      }
      const out =
        base && base.id !== route.origin.id
          ? legMetrics(rules, distance(base, route.origin), row.cruiseSpeedKmh)
          : { minutes: 0 };
      ready.push({
        aircraft: row,
        operatorName: operator!.name,
        base,
        rules,
        legMinutes: leg.minutes,
        positioningMinutes: out.minutes ?? 0,
        rangeKm: row.rangeKm,
        distanceKm: leg.distanceKm,
        windows: undefined,
        warnings: fit.warnings,
        limits,
        restrictions,
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

  /**
   * The aircraft that can fly at this departure time. No database access.
   * A round trip's return is checked for operating hours and night
   * operations as well (leaving the destination at `returnAt`); notice
   * applies to the outbound only.
   */
  evaluate(
    prepared: PreparedRoute,
    departureAt: Date,
    now: Date,
    returnAt: Date | null = null,
  ): MatchResult {
    const candidates: Candidate[] = [];
    const exclusions = [...prepared.excluded];
    const { origin, destination } = prepared.route;
    // Local times are shared by every aircraft with the same leg time, and
    // the origin's at departure by all of them: work each out once.
    const cache = new Map<string, number | null>();
    const local: LocalTime = (at, timeZone) => {
      const key = `${timeZone}|${at.getTime()}`;
      if (!cache.has(key)) cache.set(key, localMinutes(at, timeZone));
      return cache.get(key)!;
    };
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
      const legMs = (entry.legMinutes ?? 60) * 60_000;
      // Landing at the destination; an hour when the leg time is unknown.
      const arrivalAt = new Date(departureAt.getTime() + legMs);
      const timing = timeChecks({
        departureAt,
        arrivalAt,
        now,
        origin,
        destination,
        limits: entry.limits,
        restrictions: entry.restrictions,
        local,
      });
      const warnings = [...timing.warnings];
      reasons.push(...timing.reasons);
      if (returnAt) {
        // A round trip's return cannot leave before the outbound lands.
        if (arrivalAt.getTime() > returnAt.getTime())
          reasons.push('returnTime');
        const back = legTimeChecks({
          departureAt: returnAt,
          arrivalAt: new Date(returnAt.getTime() + legMs),
          origin: destination,
          destination: origin,
          restrictions: entry.restrictions,
          local,
        });
        for (const reason of back.reasons) {
          if (!reasons.includes(reason)) reasons.push(reason);
        }
        for (const warning of back.warnings) {
          if (!warnings.includes(warning)) warnings.push(warning);
        }
      }
      if (reasons.length === 0) {
        // Busy from leaving base to landing at the destination, or back at
        // the origin after a round trip.
        const from = new Date(
          departureAt.getTime() - entry.positioningMinutes * 60_000,
        );
        const to = returnAt ? new Date(returnAt.getTime() + legMs) : arrivalAt;
        if (!windowFree(entry.windows, from, to, origin.id)) {
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
          limits: _l,
          restrictions: _s,
          ...candidate
        } = entry;
        candidates.push({
          ...candidate,
          warnings: [...candidate.warnings, ...warnings],
        });
      }
    }
    return { candidates, exclusions };
  }
}

import { HttpStatus, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AppException } from '../../common/errors/app.exception.js';
import { Prisma } from '../../generated/prisma/client.js';
import {
  AircraftCategory,
  PriceType,
  ServiceCategory,
  TripType,
} from '../../generated/prisma/enums.js';
import { RoutingProvider } from '../../integrations/routing/routing.provider.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LocationsService } from '../locations/locations.service.js';
import { MatchingService } from '../matching/matching.service.js';
import { calculatePrice, type PricePoint } from '../pricing/engine.js';
import { PricingService } from '../pricing/pricing.service.js';
import { calendarDepartures } from './calendar.js';
import type {
  FareCalendarQueryDto,
  FareCalendarResponseDto,
} from './dto/calendar.dto.js';
import {
  CHARTER_CATEGORIES,
  type CharterSearchDto,
  type SearchLegDto,
  type SearchResponseDto,
  type SearchResultDetailDto,
  type SearchResultDto,
} from './dto/search.dto.js';

/** How soon a trip may depart. Per-category notice comes with operator restrictions. */
const MIN_NOTICE_MINUTES = 60;

const CANCELLATION_NOTE =
  'Cancellation conditions are set by the operator and shown with its quote, before you commit to anything.';

/** What is stored per result in `Search.results`: customer-safe only. */
interface StoredResult extends SearchResultDto {
  calculationId: string | null;
}

@Injectable()
export class SearchService {
  /** Fare calendars for five minutes, so flipping months stays cheap. */
  private readonly calendarCache = new Map<
    string,
    { expires: number; value: FareCalendarResponseDto }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly locations: LocationsService,
    private readonly matching: MatchingService,
    private readonly pricing: PricingService,
    private readonly routing: RoutingProvider,
  ) {}

  async search(
    category: 'PRIVATE_CHARTER' | 'HELICOPTER',
    dto: CharterSearchDto,
    userId: string | null,
  ): Promise<SearchResponseDto> {
    const started = Date.now();
    const now = new Date();
    const departureAt = new Date(dto.departureAt);
    if (dto.originId === dto.destinationId) {
      throw invalid('destinationId', 'must differ from originId');
    }
    if (departureAt.getTime() < now.getTime() + MIN_NOTICE_MINUTES * 60_000) {
      throw invalid('departureAt', 'must be at least an hour from now');
    }
    const { origin, destination } = await this.routePoints(
      dto.originId,
      dto.destinationId,
    );
    const rules = await this.pricing.activeRules(now);
    const { candidates, exclusions } = await this.matching.match(
      {
        categories: categoriesFor(category, dto.category),
        origin,
        destination,
        passengerCount: dto.passengerCount,
        rules,
      },
      departureAt,
      now,
    );

    const searchId = randomUUID();
    const leg: SearchLegDto = {
      originId: origin.id,
      originName: origin.name,
      destinationId: destination.id,
      destinationName: destination.name,
      departureAt: departureAt.toISOString(),
    };
    const distance = (a: PricePoint, b: PricePoint) =>
      this.routing.distanceKm(a, b);

    const results = await this.prisma.$transaction(async (tx) => {
      await tx.search.create({
        data: {
          id: searchId,
          userId,
          category,
          tripType: TripType.ONE_WAY,
          legs: [leg] as unknown as Prisma.InputJsonValue,
          passengerCount: dto.passengerCount,
          preferences: dto.category
            ? { category: dto.category }
            : Prisma.DbNull,
          results: [],
          exclusions: exclusions as unknown as Prisma.InputJsonValue,
          resultCount: 0,
          durationMs: 0,
        },
      });
      const stored: StoredResult[] = [];
      for (const candidate of candidates) {
        const { aircraft } = candidate;
        const result = calculatePrice({
          now,
          origin,
          destination,
          departureAt,
          aircraft: {
            id: aircraft.id,
            operatorId: aircraft.operatorId,
            category: aircraft.category,
            cruiseSpeedKmh: aircraft.cruiseSpeedKmh,
            base: candidate.base,
          },
          rules: candidate.rules,
          rawDistanceKm: distance,
        });
        const calculationId = result.priced
          ? await this.pricing.saveCalculation(tx, {
              searchId,
              aircraftId: aircraft.id,
              operatorId: aircraft.operatorId,
              inputs: {
                leg: { ...leg },
                passengerCount: dto.passengerCount,
                aircraft: {
                  category: aircraft.category,
                  cruiseSpeedKmh: aircraft.cruiseSpeedKmh,
                  baseId: candidate.base?.id ?? null,
                },
                distanceKm: result.distanceKm,
                flightMinutes: result.flightMinutes,
                positioningMinutes: result.positioningMinutes,
                repositioningMinutes: result.repositioningMinutes,
              },
              result,
              availabilityCheckedAt: now,
            })
          : null;
        stored.push({
          resultId: randomUUID(),
          calculationId,
          aircraft: {
            id: aircraft.id,
            manufacturer: aircraft.manufacturer,
            model: aircraft.model,
            category: aircraft.category,
            passengerCapacity: aircraft.passengerCapacity,
          },
          operatorName: candidate.operatorName,
          distanceKm: result.distanceKm,
          flightMinutes: result.flightMinutes,
          price: result.priced
            ? {
                priceType: PriceType.ESTIMATE,
                amountMinor: result.totalMinor,
                currency: result.currency,
              }
            : null,
          validUntil: result.validUntil.toISOString(),
          warnings: result.priced ? [] : result.warnings,
        });
      }
      // Priced first, cheapest first.
      stored.sort(
        (a, b) =>
          (a.price?.amountMinor ?? Number.MAX_SAFE_INTEGER) -
          (b.price?.amountMinor ?? Number.MAX_SAFE_INTEGER),
      );
      await tx.search.update({
        where: { id: searchId },
        data: {
          results: stored as unknown as Prisma.InputJsonValue,
          resultCount: stored.length,
          durationMs: Date.now() - started,
        },
      });
      return stored;
    });

    return {
      searchId,
      category,
      legs: [leg],
      passengerCount: dto.passengerCount,
      createdAt: now.toISOString(),
      results: results.map(publicResult),
    };
  }

  async get(searchId: string): Promise<SearchResponseDto> {
    const search = await this.find(searchId);
    const results = search.results as unknown as StoredResult[];
    return {
      searchId: search.id,
      category: search.category,
      legs: search.legs as unknown as SearchLegDto[],
      passengerCount: search.passengerCount,
      createdAt: search.createdAt.toISOString(),
      results: results.map(publicResult),
    };
  }

  async result(
    searchId: string,
    resultId: string,
  ): Promise<SearchResultDetailDto> {
    const search = await this.find(searchId);
    const stored = (search.results as unknown as StoredResult[]).find(
      (entry) => entry.resultId === resultId,
    );
    if (!stored) throw notFound('Result');
    const calculation = stored.calculationId
      ? await this.pricing.calculation(stored.calculationId)
      : null;
    return {
      ...publicResult(stored),
      searchId: search.id,
      legs: search.legs as unknown as SearchLegDto[],
      passengerCount: search.passengerCount,
      breakdown: (calculation?.breakdown ??
        []) as unknown as SearchResultDetailDto['breakdown'],
      assumptions: (calculation?.assumptions ?? []) as string[],
      exclusions: (calculation?.exclusions ?? []) as string[],
      bookingMode: 'REQUEST',
      confirmationRequirements: [
        'The operator confirms the aircraft, crew and price',
        'Availability and price are checked again before you pay',
      ],
      cancellationNote: CANCELLATION_NOTE,
    };
  }

  /**
   * The fare calendar: for each day of a month, how many aircraft can fly
   * the route at 10:00 India time and the lowest estimate among them.
   * Previews only: nothing is stored; the real search stores its prices.
   */
  async calendar(
    query: FareCalendarQueryDto,
  ): Promise<FareCalendarResponseDto> {
    const key = JSON.stringify(query);
    const cached = this.calendarCache.get(key);
    if (cached && cached.expires > Date.now()) return cached.value;

    if (query.originId === query.destinationId) {
      throw invalid('destinationId', 'must differ from originId');
    }
    const now = new Date();
    const { origin, destination } = await this.routePoints(
      query.originId,
      query.destinationId,
    );
    const departures = calendarDepartures(query.month, now, MIN_NOTICE_MINUTES);
    const days: FareCalendarResponseDto['days'] = [];
    if (departures.length > 0) {
      const prepared = await this.matching.prepare(
        {
          categories: categoriesFor(query.category, query.aircraftCategory),
          origin,
          destination,
          passengerCount: query.passengerCount,
          rules: await this.pricing.activeRules(now),
        },
        departures[0].departureAt,
        departures[departures.length - 1].departureAt,
      );
      const distance = (a: PricePoint, b: PricePoint) =>
        this.routing.distanceKm(a, b);
      for (const { date, departureAt } of departures) {
        const { candidates } = this.matching.evaluate(
          prepared,
          departureAt,
          now,
        );
        let lowest: number | null = null;
        for (const candidate of candidates) {
          const result = calculatePrice({
            now,
            origin,
            destination,
            departureAt,
            aircraft: {
              id: candidate.aircraft.id,
              operatorId: candidate.aircraft.operatorId,
              category: candidate.aircraft.category,
              cruiseSpeedKmh: candidate.aircraft.cruiseSpeedKmh,
              base: candidate.base,
            },
            rules: candidate.rules,
            rawDistanceKm: distance,
          });
          if (result.priced && (lowest == null || result.totalMinor < lowest)) {
            lowest = result.totalMinor;
          }
        }
        days.push({
          date,
          availableCount: candidates.length,
          lowest:
            lowest == null
              ? null
              : {
                  priceType: PriceType.ESTIMATE,
                  amountMinor: lowest,
                  currency: 'INR',
                },
        });
      }
    }
    const value: FareCalendarResponseDto = { month: query.month, days };
    if (this.calendarCache.size > 500) this.calendarCache.clear();
    this.calendarCache.set(key, {
      expires: Date.now() + CALENDAR_TTL_MS,
      value,
    });
    return value;
  }

  private async routePoints(originId: string, destinationId: string) {
    const points = await this.locations.pricingPoints([
      originId,
      destinationId,
    ]);
    const origin = points.get(originId);
    const destination = points.get(destinationId);
    if (!origin) throw invalid('originId', 'must be an active location');
    if (!destination) {
      throw invalid('destinationId', 'must be an active location');
    }
    return { origin, destination };
  }

  private async find(searchId: string) {
    const search = await this.prisma.search.findUnique({
      where: { id: searchId },
    });
    if (!search || !isCustomerCategory(search.category)) {
      throw notFound('Search');
    }
    return search;
  }
}

const CALENDAR_TTL_MS = 5 * 60_000;

function categoriesFor(
  category: 'PRIVATE_CHARTER' | 'HELICOPTER',
  fixedWing?: (typeof CHARTER_CATEGORIES)[number],
): AircraftCategory[] {
  if (category === 'HELICOPTER') return [AircraftCategory.HELICOPTER];
  return fixedWing ? [fixedWing] : [...CHARTER_CATEGORIES];
}

function isCustomerCategory(category: ServiceCategory): boolean {
  return (
    category === ServiceCategory.PRIVATE_CHARTER ||
    category === ServiceCategory.HELICOPTER
  );
}

/** Drops the internal calculation reference. */
function publicResult(stored: StoredResult): SearchResultDto {
  const { calculationId: _calculationId, ...result } = stored;
  return result;
}

function invalid(field: string, issue: string): AppException {
  return new AppException(
    'VALIDATION_ERROR',
    'The search could not be run.',
    HttpStatus.BAD_REQUEST,
    [{ field, issue }],
  );
}

function notFound(what: string): AppException {
  return new AppException(
    'NOT_FOUND',
    `${what} not found.`,
    HttpStatus.NOT_FOUND,
  );
}

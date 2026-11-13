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
    const points = await this.locations.pricingPoints([
      dto.originId,
      dto.destinationId,
    ]);
    const origin = points.get(dto.originId);
    const destination = points.get(dto.destinationId);
    if (!origin) throw invalid('originId', 'must be an active location');
    if (!destination)
      throw invalid('destinationId', 'must be an active location');

    const categories: AircraftCategory[] =
      category === 'HELICOPTER'
        ? [AircraftCategory.HELICOPTER]
        : dto.category
          ? [dto.category]
          : [...CHARTER_CATEGORIES];
    const rules = await this.pricing.activeRules(now);
    const { candidates, exclusions } = await this.matching.match({
      categories,
      origin,
      destination,
      departureAt,
      passengerCount: dto.passengerCount,
      rules,
      now,
    });

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

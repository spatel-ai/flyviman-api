import { HttpStatus, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AppException } from '../../common/errors/app.exception.js';
import { Prisma } from '../../generated/prisma/client.js';
import {
  AircraftCategory,
  BookingMode,
  PriceType,
  ServiceCategory,
  TripType,
} from '../../generated/prisma/enums.js';
import { RoutingProvider } from '../../integrations/routing/routing.provider.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CategoryConfigService } from '../configuration/category-config.service.js';
import { LocationsService } from '../locations/locations.service.js';
import {
  type Candidate,
  MatchingService,
} from '../matching/matching.service.js';
import {
  calculatePrice,
  type EngineResult,
  type PricePoint,
} from '../pricing/engine.js';
import {
  CancellationTermsService,
  publicTerms,
} from '../pricing/cancellation-terms.service.js';
import {
  type CalculationRow,
  PricingService,
} from '../pricing/pricing.service.js';
import type { PromoPreviewResponseDto } from '../pricing/dto/promotion.dto.js';
import type { PromotionTrip } from '../pricing/promotions.js';
import {
  type AppliedPromotion,
  promotionRefusal,
  PromotionsService,
} from '../pricing/promotions.service.js';
import { customerAssumptions, customerBreakdown } from './breakdown.js';
import { EmptyLegsService } from '../empty-legs/empty-legs.service.js';
import { calendarDepartures, monthInRange } from './calendar.js';
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
  type SearchTripType,
} from './dto/search.dto.js';

/**
 * How soon any trip may depart. Longer notice per category, operator or
 * aircraft is a matching check (`notice`).
 */
const MIN_NOTICE_MINUTES = 60;
/** A round trip's return leaves at least this long after the outbound. */
const MIN_RETURN_GAP_MINUTES = 60;
/** And within this many days of it. */
const MAX_RETURN_DAYS = 30;

/** What is stored per result in `Search.results`: customer-safe only. */
interface StoredResult extends SearchResultDto {
  calculationId: string | null;
}

/** A stored result checked again (`SearchService.revalidate`). */
export interface Revalidation {
  searchId: string;
  resultId: string;
  category: 'PRIVATE_CHARTER' | 'HELICOPTER';
  legs: SearchLegDto[];
  passengerCount: number;
  /** As the search offered it (customer-safe fields only). */
  result: ResultFields;
  /**
   * Null when the aircraft can no longer fly the trip. Unpriced when the
   * operator prices it on request: a booking from it asks for a quote.
   */
  current:
    | null
    | {
        operatorId: string;
        priced: false;
        /** The time the aircraft is busy with this trip. */
        hold: { startsAt: Date; endsAt: Date };
      }
    | {
        operatorId: string;
        priced: true;
        totalMinor: number;
        currency: string;
        validUntil: Date;
        /** The time the aircraft is busy with this trip. */
        hold: { startsAt: Date; endsAt: Date };
        /** Stores this price as an immutable calculation. */
        saveCalculation: (tx: Prisma.TransactionClient) => Promise<string>;
        /** The promotion code applied to this price, to redeem on booking. */
        promotion: {
          promotionId: string;
          trip: PromotionTrip;
          amountOffMinor: number;
        } | null;
        /** The customer's breakdown and assumptions of this price. */
        breakdown: { code: string; label: string; amountMinor: number }[];
        assumptions: string[];
      };
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
    private readonly categories: CategoryConfigService,
    private readonly emptyLegs: EmptyLegsService,
    private readonly cancellationTerms: CancellationTermsService,
    private readonly promotions: PromotionsService,
  ) {}

  async search(
    category: 'PRIVATE_CHARTER' | 'HELICOPTER',
    dto: CharterSearchDto,
    userId: string | null,
  ): Promise<SearchResponseDto> {
    const started = Date.now();
    // Not while the platform has the category switched off (M10).
    await this.categories.assertEnabled(category);
    const now = new Date();
    const departureAt = new Date(dto.departureAt);
    if (dto.originId === dto.destinationId) {
      throw invalid('destinationId', 'must differ from originId');
    }
    if (departureAt.getTime() < now.getTime() + MIN_NOTICE_MINUTES * 60_000) {
      throw invalid('departureAt', 'must be at least an hour from now');
    }
    const tripType = dto.tripType ?? 'ONE_WAY';
    const returnAt = returnTime(tripType, departureAt, dto.returnAt);
    const { origin, destination } = await this.routePoints(
      dto.originId,
      dto.destinationId,
    );
    const rules = await this.pricing.activeRules(now);
    const categories = categoriesFor(category, dto.category);
    const rawKm = this.routing.distanceKm(origin, destination);
    const issue = this.matching.tripLimitIssue({
      rules,
      categories,
      // Only platform and category rules resolve without an aircraft.
      distanceKm: (aircraftCategory) =>
        this.pricing.categoryLegKm(rules, aircraftCategory, rawKm),
      departureAt,
      now,
    });
    if (issue) throw invalid(issue.field, issue.issue);
    const { candidates, exclusions } = await this.matching.match(
      {
        categories,
        origin,
        destination,
        passengerCount: dto.passengerCount,
        rules,
      },
      departureAt,
      now,
      returnAt,
    );

    const searchId = randomUUID();
    const leg: SearchLegDto = {
      originId: origin.id,
      originName: origin.name,
      destinationId: destination.id,
      destinationName: destination.name,
      departureAt: departureAt.toISOString(),
    };
    const legs: SearchLegDto[] = returnAt
      ? [
          leg,
          {
            originId: destination.id,
            originName: destination.name,
            destinationId: origin.id,
            destinationName: origin.name,
            departureAt: returnAt.toISOString(),
          },
        ]
      : [leg];
    const distance = (a: PricePoint, b: PricePoint) =>
      this.routing.distanceKm(a, b);

    // Every result is priced and given its calculation's id first, so the
    // search and all its calculations are stored with two inserts.
    const calculations: CalculationRow[] = [];
    const stored: StoredResult[] = candidates.map((candidate) => {
      const { aircraft } = candidate;
      const { result, inputs } = priceCandidate(
        { origin, destination, departureAt, returnAt, tripType, now },
        dto.passengerCount,
        candidate,
        distance,
      );
      const calculationId = result.priced ? randomUUID() : null;
      if (calculationId) {
        calculations.push({
          id: calculationId,
          searchId,
          aircraftId: aircraft.id,
          operatorId: aircraft.operatorId,
          inputs,
          result,
          availabilityCheckedAt: now,
        });
      }
      return {
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
        tripType,
        returnAt: returnAt?.toISOString() ?? null,
        roundTripStrategy: result.roundTrip?.strategy ?? null,
        price: result.priced
          ? {
              priceType: PriceType.ESTIMATE,
              amountMinor: result.totalMinor,
              currency: result.currency,
            }
          : null,
        // A list price that leaves things out is marked (pricing-engine.md,
        // principle 4); the detail says what.
        incomplete: result.priced && result.exclusions.length > 0,
        validUntil: result.validUntil.toISOString(),
        // The engine's reasons (no rate, no cruise speed) are operator
        // matters; they stay in the logs of pricing, not in front of
        // customers. Matching's (landing-site permission, night operations
        // not confirmed) are for the customer.
        warnings: [
          ...candidate.warnings,
          ...(result.priced ? [] : [PRICE_ON_REQUEST]),
        ],
      };
    });
    // Priced first, cheapest first.
    stored.sort(
      (a, b) =>
        (a.price?.amountMinor ?? Number.MAX_SAFE_INTEGER) -
        (b.price?.amountMinor ?? Number.MAX_SAFE_INTEGER),
    );
    await this.prisma.$transaction(async (tx) => {
      await tx.search.create({
        data: {
          id: searchId,
          userId,
          category,
          tripType: returnAt ? TripType.ROUND_TRIP : TripType.ONE_WAY,
          legs: legs as unknown as Prisma.InputJsonValue,
          passengerCount: dto.passengerCount,
          preferences: dto.category
            ? { category: dto.category }
            : Prisma.DbNull,
          results: stored as unknown as Prisma.InputJsonValue,
          exclusions: exclusions as unknown as Prisma.InputJsonValue,
          resultCount: stored.length,
          // Matching and pricing; the two inserts are not counted.
          durationMs: Date.now() - started,
        },
      });
      await this.pricing.saveCalculations(tx, calculations);
    });

    return {
      searchId,
      category,
      aircraftCategory: dto.category ?? null,
      legs,
      passengerCount: dto.passengerCount,
      createdAt: now.toISOString(),
      results: stored.map(publicResult),
      emptyLegAlternatives: await this.alternatives(
        category,
        dto.originId,
        dto.destinationId,
        departureAt,
        dto.passengerCount,
        { origin, destination },
      ),
    };
  }

  /** Empty legs for a charter trip's outbound flight; none for helicopters. */
  private async alternatives(
    category: SearchResponseDto['category'],
    originId: string,
    destinationId: string,
    departureAt: Date,
    passengers: number,
    points?: Parameters<EmptyLegsService['alternativesFor']>[0]['points'],
  ): Promise<SearchResponseDto['emptyLegAlternatives']> {
    if (category !== 'PRIVATE_CHARTER') return [];
    // None while empty legs are switched off (M10).
    if (!(await this.categories.isEnabled(ServiceCategory.EMPTY_LEG))) {
      return [];
    }
    return this.emptyLegs.alternativesFor({
      originId,
      destinationId,
      departureAt,
      passengers,
      points,
    });
  }

  async get(searchId: string): Promise<SearchResponseDto> {
    const search = await this.find(searchId);
    const results = search.results as unknown as StoredResult[];
    const legs = search.legs as unknown as SearchLegDto[];
    return {
      searchId: search.id,
      category: search.category,
      aircraftCategory: preferredCategory(search.preferences),
      legs,
      passengerCount: search.passengerCount,
      createdAt: search.createdAt.toISOString(),
      results: results.map(publicResult),
      emptyLegAlternatives: await this.alternatives(
        search.category,
        legs[0].originId,
        legs[0].destinationId,
        new Date(legs[0].departureAt),
        search.passengerCount,
      ),
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
    // How this aircraft's operator books the category, as a booking made
    // from this result would be (C2): the platform row and the operator's
    // own override.
    const aircraft = await this.prisma.aircraft.findUnique({
      where: { id: stored.aircraft.id },
      select: { operatorId: true },
    });
    const { bookingMode } = await this.categories.resolve(search.category, {
      operatorId: aircraft?.operatorId,
    });
    // Flyviman's tiers, one table for every operator (D-172), shown before
    // the customer commits and snapshotted on the request (rule 9).
    const terms = await this.cancellationTerms.current();
    return {
      ...publicResult(stored),
      searchId: search.id,
      legs: search.legs as unknown as SearchLegDto[],
      passengerCount: search.passengerCount,
      breakdown: customerBreakdown(
        (calculation?.breakdown ?? []) as {
          code: string;
          label: string;
          amountMinor: number;
        }[],
      ),
      assumptions: customerAssumptions(calculation?.assumptions),
      exclusions: (calculation?.exclusions ?? []) as string[],
      bookingMode,
      confirmationRequirements: confirmationRequirements(
        bookingMode,
        stored.price !== null,
      ),
      cancellationNote: terms.summary,
      cancellationTerms: publicTerms(terms),
    };
  }

  /**
   * Checks a stored result again before a booking is made from it (business
   * rule 3): matching is run afresh for that aircraft at the search's times
   * and the trip priced again exactly as the search priced it. `current` is
   * null when the aircraft can no longer fly the trip.
   */
  async revalidate(
    searchId: string,
    resultId: string,
    promo: { code: string; customerId: string | null } | null = null,
  ): Promise<Revalidation> {
    const search = await this.find(searchId);
    const stored = (search.results as unknown as StoredResult[]).find(
      (entry) => entry.resultId === resultId,
    );
    if (!stored) throw notFound('Result');
    const legs = search.legs as unknown as SearchLegDto[];
    const category = search.category as 'PRIVATE_CHARTER' | 'HELICOPTER';
    // A code that cannot be used says why before anything is priced.
    const promotionTrip: PromotionTrip = {
      now: new Date(),
      category,
      originId: legs[0].originId,
      destinationId: legs[0].destinationId,
    };
    const applied: AppliedPromotion | null = promo
      ? await this.promotions.forCode(
          promo.code,
          promotionTrip,
          promo.customerId,
        )
      : null;
    const result = publicResult(stored);
    const base = {
      searchId: search.id,
      resultId,
      category,
      legs,
      passengerCount: search.passengerCount,
      result,
    };

    const now = new Date();
    const departureAt = new Date(legs[0].departureAt);
    const returnAt = legs[1] ? new Date(legs[1].departureAt) : null;
    if (departureAt.getTime() < now.getTime() + MIN_NOTICE_MINUTES * 60_000) {
      return { ...base, current: null };
    }
    const points = await this.locations.pricingPoints([
      legs[0].originId,
      legs[0].destinationId,
    ]);
    const origin = points.get(legs[0].originId);
    const destination = points.get(legs[0].destinationId);
    if (!origin || !destination) return { ...base, current: null };
    const { candidates } = await this.matching.match(
      {
        categories: [stored.aircraft.category],
        origin,
        destination,
        passengerCount: search.passengerCount,
        rules: await this.pricing.activeRules(now),
      },
      departureAt,
      now,
      returnAt,
    );
    const candidate = candidates.find(
      (entry) => entry.aircraft.id === stored.aircraft.id,
    );
    if (!candidate) return { ...base, current: null };

    const { result: price, inputs } = priceCandidate(
      {
        origin,
        destination,
        departureAt,
        returnAt,
        tripType: result.tripType,
        now,
      },
      search.passengerCount,
      candidate,
      (a, b) => this.routing.distanceKm(a, b),
      applied,
    );
    const operatorId = candidate.aircraft.operatorId;
    // Busy from leaving base to landing at the destination, or back at the
    // origin after a round trip: the window matching checked.
    const legMs = (candidate.legMinutes ?? 60) * 60_000;
    const hold = {
      startsAt: new Date(
        departureAt.getTime() - candidate.positioningMinutes * 60_000,
      ),
      endsAt: new Date((returnAt ?? departureAt).getTime() + legMs),
    };
    if (!price.priced) {
      // Priced on request: the operator's quote sets the price, not a code.
      if (applied) throw promotionRefusal('PROMO_CODE_NOT_APPLICABLE');
      return { ...base, current: { operatorId, priced: false, hold } };
    }
    return {
      ...base,
      current: {
        operatorId,
        priced: true,
        totalMinor: price.totalMinor,
        currency: price.currency,
        validUntil: price.validUntil,
        hold,
        saveCalculation: (tx) =>
          this.pricing.saveCalculation(tx, {
            searchId: search.id,
            aircraftId: candidate.aircraft.id,
            operatorId,
            inputs,
            result: price,
            availabilityCheckedAt: now,
          }),
        promotion: applied
          ? {
              promotionId: applied.promotionId,
              trip: promotionTrip,
              amountOffMinor: -(
                price.breakdown.find((line) => line.code === 'PROMOTION')
                  ?.amountMinor ?? 0
              ),
            }
          : null,
        breakdown: customerBreakdown(price.breakdown),
        assumptions: customerAssumptions(price.assumptions),
      },
    };
  }

  /**
   * A customer's promotion code on one result (M10): the trip priced again
   * with it, as a booking would be. Nothing is stored. Signed in, the
   * customer's own limit is checked too; otherwise it is checked on booking.
   */
  async previewPromoCode(
    searchId: string,
    resultId: string,
    code: string,
    customerId: string | null,
  ): Promise<PromoPreviewResponseDto> {
    const { current } = await this.revalidate(searchId, resultId, {
      code,
      customerId,
    });
    if (!current) {
      throw new AppException(
        'BOOKING_UNAVAILABLE',
        'This aircraft is no longer available for this trip.',
        HttpStatus.CONFLICT,
      );
    }
    // `revalidate` refuses a code on a trip priced on request.
    if (!current.priced || !current.promotion) {
      throw promotionRefusal('PROMO_CODE_NOT_APPLICABLE');
    }
    const line = current.breakdown.find((entry) => entry.code === 'PROMOTION');
    return {
      code: code.trim().toUpperCase(),
      name: line?.label ?? code,
      amountOffMinor: current.promotion.amountOffMinor,
      price: {
        priceType: PriceType.ESTIMATE,
        amountMinor: current.totalMinor,
        currency: current.currency,
        validUntil: current.validUntil.toISOString(),
      },
      breakdown: current.breakdown,
      assumptions: current.assumptions,
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
    await this.categories.assertEnabled(query.category);
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
    if (!monthInRange(query.month, now, CALENDAR_MONTHS_AHEAD)) {
      throw invalid(
        'month',
        `must be this month or one of the next ${CALENDAR_MONTHS_AHEAD}`,
      );
    }
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
              pricingModel: candidate.aircraft.pricingModel,
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
    // Full: drop the oldest entry (Maps keep insertion order), never the lot.
    if (this.calendarCache.size >= CALENDAR_CACHE_SIZE) {
      const oldest = this.calendarCache.keys().next().value;
      if (oldest !== undefined) this.calendarCache.delete(oldest);
    }
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
const CALENDAR_CACHE_SIZE = 500;
const CALENDAR_MONTHS_AHEAD = 12;
const PRICE_ON_REQUEST =
  'The operator prices this aircraft on request. Send a quote request and the operator will quote you before you commit to anything.';

/**
 * What must happen before a booking from a result is confirmed, as the
 * result detail lists it. Only a booking on request waits for the operator:
 * an instant booking never says the operator confirms (its price is still
 * checked again). A price on request is always quoted by the operator.
 */
export function confirmationRequirements(
  bookingMode: BookingMode,
  priced: boolean,
): string[] {
  if (!priced) {
    return [
      'The operator sends you a quote with its conditions',
      'You accept the quote before anything is charged',
    ];
  }
  return bookingMode === BookingMode.INSTANT
    ? [
        'Your price is confirmed before you pay',
        'Availability and price are checked again before you pay',
      ]
    : [
        'The operator confirms the aircraft, crew and price',
        'Availability and price are checked again before you pay',
      ];
}

/** The trip a candidate is priced for. */
interface PricedTrip {
  origin: PricePoint;
  destination: PricePoint;
  departureAt: Date;
  returnAt: Date | null;
  tripType: SearchTripType;
  now: Date;
}

/**
 * Prices one matched aircraft and the inputs its calculation records. Shared
 * by search and revalidation, so a booking is priced exactly as the search
 * that offered it.
 */
function priceCandidate(
  trip: PricedTrip,
  passengerCount: number,
  candidate: Candidate,
  distance: (a: PricePoint, b: PricePoint) => number,
  promotion: AppliedPromotion | null = null,
): { result: EngineResult; inputs: Prisma.InputJsonValue } {
  const { aircraft } = candidate;
  const { origin, destination, departureAt, returnAt, now } = trip;
  const result = calculatePrice({
    now,
    origin,
    destination,
    departureAt,
    returnAt,
    aircraft: {
      id: aircraft.id,
      operatorId: aircraft.operatorId,
      category: aircraft.category,
      pricingModel: aircraft.pricingModel,
      cruiseSpeedKmh: aircraft.cruiseSpeedKmh,
      base: candidate.base,
    },
    rules: candidate.rules,
    rawDistanceKm: distance,
    promotion: promotion?.input ?? null,
  });
  const inputs: Prisma.InputJsonValue = {
    leg: {
      originId: origin.id,
      destinationId: destination.id,
      departureAt: departureAt.toISOString(),
    },
    tripType: trip.tripType,
    returnAt: returnAt?.toISOString() ?? null,
    roundTrip: result.roundTrip as unknown as Prisma.InputJsonValue,
    passengerCount,
    aircraft: {
      category: aircraft.category,
      pricingModel: aircraft.pricingModel,
      cruiseSpeedKmh: aircraft.cruiseSpeedKmh,
      baseId: candidate.base?.id ?? null,
    },
    distanceKm: result.distanceKm,
    flightMinutes: result.flightMinutes,
    positioningMinutes: result.positioningMinutes,
    repositioningMinutes: result.repositioningMinutes,
    // The code's terms as applied, so the price stays explainable.
    ...(promotion
      ? { promotion: promotion.input as unknown as Prisma.InputJsonObject }
      : {}),
  };
  return { result, inputs };
}

function categoriesFor(
  category: 'PRIVATE_CHARTER' | 'HELICOPTER',
  fixedWing?: (typeof CHARTER_CATEGORIES)[number],
): AircraftCategory[] {
  if (category === 'HELICOPTER') return [AircraftCategory.HELICOPTER];
  return fixedWing ? [fixedWing] : [...CHARTER_CATEGORIES];
}

function preferredCategory(
  preferences: unknown,
): (typeof CHARTER_CATEGORIES)[number] | null {
  const value = (preferences as { category?: string } | null)?.category;
  return CHARTER_CATEGORIES.includes(
    value as (typeof CHARTER_CATEGORIES)[number],
  )
    ? (value as (typeof CHARTER_CATEGORIES)[number])
    : null;
}

function isCustomerCategory(category: ServiceCategory): boolean {
  return (
    category === ServiceCategory.PRIVATE_CHARTER ||
    category === ServiceCategory.HELICOPTER
  );
}

/** Drops the internal calculation reference. */
/** A result's fields as a plain object (not the DTO class), safe to spread. */
type ResultFields = { [K in keyof SearchResultDto]: SearchResultDto[K] };

function publicResult(stored: StoredResult): ResultFields {
  const { calculationId: _calculationId, ...result } = stored;
  // Searches stored before round trips (M5 slice 4b) were all one-way.
  return {
    ...result,
    tripType: result.tripType ?? 'ONE_WAY',
    returnAt: result.returnAt ?? null,
    roundTripStrategy: result.roundTripStrategy ?? null,
    // Searches stored before the flag: the detail still lists exclusions.
    incomplete: result.incomplete ?? false,
  };
}

/** The round trip's return departure, checked; null for a one-way trip. */
function returnTime(
  tripType: SearchTripType,
  departureAt: Date,
  returnAt: string | null | undefined,
): Date | null {
  if (tripType === 'ONE_WAY') {
    if (returnAt != null) {
      throw invalid('returnAt', 'is only for a round trip');
    }
    return null;
  }
  if (returnAt == null) {
    throw invalid('returnAt', 'is required for a round trip');
  }
  const at = new Date(returnAt);
  const gap = at.getTime() - departureAt.getTime();
  if (gap < MIN_RETURN_GAP_MINUTES * 60_000) {
    throw invalid('returnAt', 'must be at least an hour after departureAt');
  }
  if (gap > MAX_RETURN_DAYS * 86_400_000) {
    throw invalid(
      'returnAt',
      `must be within ${MAX_RETURN_DAYS} days of departureAt`,
    );
  }
  return at;
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

import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { AppException } from '../../common/errors/app.exception.js';
import { Prisma } from '../../generated/prisma/client.js';
import { ServiceCategory, TripType } from '../../generated/prisma/enums.js';
import {
  AIRLINE_PROVIDERS,
  AirlineProviderError,
  type FareOffer,
  type FareSearchResult,
  type NamedAirlineProvider,
} from '../../integrations/airline/airline.provider.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CategoryConfigService } from '../configuration/category-config.service.js';
import {
  LocationsService,
  type LocationSummary,
} from '../locations/locations.service.js';
import type {
  RevalidateScheduledDto,
  ScheduledCabin,
  ScheduledFareRulesDto,
  ScheduledOfferDto,
  ScheduledPassengersDto,
  ScheduledProviderStatusDto,
  ScheduledRevalidationDto,
  ScheduledSearchDto,
  ScheduledSearchResponseDto,
} from './dto/scheduled-search.dto.js';
import { callAll } from './fan-out.js';
import { localIso, localToday } from './local-time.js';

/** How far ahead a scheduled search may go, in days. */
const MAX_DAYS_AHEAD = 365;
const DAY_MS = 86_400_000;

/** A result as stored in `Search.results`: the offer plus where it came from. */
interface StoredOffer extends ScheduledOfferDto {
  /** Supplier name, from AIRLINE_PROVIDERS. Never returned. */
  provider: string;
  /** The supplier's own offer id. Never returned: clients use `offerId`. */
  providerOfferId: string;
  /** Set when revalidation found it sold out: no longer listed (rule 4). */
  soldOut?: boolean;
}

/** `Search.preferences` for a scheduled search. */
interface StoredQuery {
  passengers: { adults: number; children: number; infants: number };
  cabin: ScheduledCabin;
  departureDate: string;
  returnDate: string | null;
  validUntil: string;
}

/**
 * Scheduled airline search (M6). Calls every configured supplier in
 * parallel with a timeout each and keeps whatever answered (partial
 * results). Every fare is a `LIVE_FARE` (rule 1), checked again by
 * revalidation before payment (rule 3). A search and its fares expire
 * together after AIRLINE_OFFER_TTL_MINUTES.
 */
@Injectable()
export class ScheduledSearchService {
  private readonly logger = new Logger(ScheduledSearchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly locations: LocationsService,
    private readonly config: ConfigService,
    @Inject(AIRLINE_PROVIDERS)
    private readonly providers: NamedAirlineProvider[],
    private readonly categories: CategoryConfigService,
  ) {}

  async search(
    dto: ScheduledSearchDto,
    userId: string | null,
  ): Promise<ScheduledSearchResponseDto> {
    const started = Date.now();
    // Not while the platform has the category switched off (M10).
    await this.categories.assertEnabled(ServiceCategory.SCHEDULED_AIRLINE);
    const now = new Date();
    if (dto.originId === dto.destinationId) {
      throw invalid('destinationId', 'must differ from originId');
    }
    const points = await this.locations.activeSummaries([
      dto.originId,
      dto.destinationId,
    ]);
    const origin = points.get(dto.originId);
    const destination = points.get(dto.destinationId);
    if (!origin?.iata) {
      throw invalid('originId', 'must be an active airport with an IATA code');
    }
    if (!destination?.iata) {
      throw invalid(
        'destinationId',
        'must be an active airport with an IATA code',
      );
    }
    checkDates(dto, localToday(origin.timeZone, now));
    checkParty(dto.passengers);

    const query = {
      origin: origin.iata,
      destination: destination.iata,
      departDate: dto.departureDate,
      returnDate: dto.returnDate,
      adults: dto.passengers.adults,
      children: dto.passengers.children,
      infants: dto.passengers.infants,
      cabin: dto.cabin,
    };
    const outcomes = await callAll(
      this.providers.map(({ name, provider }) => ({
        name,
        run: async (): Promise<FareSearchResult> => {
          try {
            return await provider.searchFares(query);
          } catch (error) {
            // We validated the query, so a refusal means the supplier does
            // not serve one of the airports: no flights, not a failure.
            if (
              error instanceof AirlineProviderError &&
              error.code === 'INVALID_QUERY'
            ) {
              return { outbound: [], inbound: query.returnDate ? [] : null };
            }
            throw error;
          }
        },
      })),
      this.config.getOrThrow<number>('AIRLINE_TIMEOUT_MS'),
    );
    const providers: ScheduledProviderStatusDto[] = outcomes.map(
      ({ name, status }) => ({ name, status }),
    );
    for (const { name, status } of providers) {
      // Name and status only: a supplier's message can repeat the query.
      if (status !== 'OK') this.logger.warn({ provider: name, status });
    }

    const validUntil = new Date(now.getTime() + this.ttlMs()).toISOString();
    const found: { name: string; offer: FareOffer; direction: Direction }[] =
      [];
    for (const outcome of outcomes) {
      if (outcome.status !== 'OK') continue;
      for (const offer of outcome.value.outbound) {
        found.push({ name: outcome.name, offer, direction: 'OUTBOUND' });
      }
      for (const offer of outcome.value.inbound ?? []) {
        found.push({ name: outcome.name, offer, direction: 'RETURN' });
      }
    }
    const airports = await this.locations.activeSummariesByIata([
      ...new Set(
        found.flatMap(({ offer }) => [offer.origin, offer.destination]),
      ),
    ]);
    const results: StoredOffer[] = [];
    for (const { name, offer, direction } of found) {
      const from = airports.get(offer.origin);
      const to = airports.get(offer.destination);
      // Gone already, or at an airport we do not list: not bookable.
      if (!from || !to || Date.parse(offer.departureAt) <= now.getTime()) {
        continue;
      }
      results.push(toStored(name, offer, direction, from, to, validUntil));
    }
    results.sort(
      (a, b) =>
        (a.direction === b.direction
          ? 0
          : a.direction === 'OUTBOUND'
            ? -1
            : 1) ||
        Date.parse(a.segments[0].departAt) -
          Date.parse(b.segments[0].departAt) ||
        a.fare.amountMinor - b.fare.amountMinor,
    );

    const searchId = randomUUID();
    const stored: StoredQuery = {
      passengers: {
        adults: dto.passengers.adults,
        children: dto.passengers.children,
        infants: dto.passengers.infants,
      },
      cabin: dto.cabin,
      departureDate: dto.departureDate,
      returnDate: dto.returnDate ?? null,
      validUntil,
    };
    await this.prisma.search.create({
      data: {
        id: searchId,
        userId,
        category: ServiceCategory.SCHEDULED_AIRLINE,
        tripType: dto.returnDate ? TripType.ROUND_TRIP : TripType.ONE_WAY,
        legs: [
          {
            originId: origin.id,
            destinationId: destination.id,
            date: dto.departureDate,
          },
          ...(dto.returnDate
            ? [
                {
                  originId: destination.id,
                  destinationId: origin.id,
                  date: dto.returnDate,
                },
              ]
            : []),
        ],
        passengerCount:
          dto.passengers.adults +
          dto.passengers.children +
          dto.passengers.infants,
        preferences: stored as unknown as Prisma.InputJsonValue,
        results: results as unknown as Prisma.InputJsonValue,
        resultCount: results.length,
        durationMs: Date.now() - started,
        providerStatus: providers as unknown as Prisma.InputJsonValue,
      },
    });
    return response(searchId, stored.passengers, providers, results);
  }

  async get(searchId: string): Promise<ScheduledSearchResponseDto> {
    const { search, query, results } = await this.find(searchId);
    return response(
      search.id,
      query.passengers,
      search.providerStatus as unknown as ScheduledProviderStatusDto[],
      results,
    );
  }

  async fareRules(
    searchId: string,
    offerId: string,
  ): Promise<ScheduledFareRulesDto> {
    const { offer } = await this.findOffer(searchId, offerId);
    if (offer.soldOut) throw notFound('Offer');
    const rules = await this.callProvider(offer, (provider) =>
      provider.getFareRules(offer.providerOfferId),
    );
    if (rules === 'GONE') throw notFound('Offer');
    return {
      offerId,
      rules: rules.conditions.map(({ title, text }) => ({ title, text })),
      cancellation: {
        refundable: rules.refundable,
        ...(rules.refundable && rules.cancellationFeeMinor !== null
          ? { feeMinor: rules.cancellationFeeMinor }
          : {}),
      },
      change: {
        allowed: rules.changeFeeMinor !== null,
        ...(rules.changeFeeMinor !== null
          ? { feeMinor: rules.changeFeeMinor }
          : {}),
      },
    };
  }

  /**
   * Rechecks the fare and seats of an offer with its supplier (rule 3)
   * against the fare last shown, and stores the outcome on the offer: the
   * fare now and its validity (never past the search's own expiry), or
   * sold out, which takes it off the results. A second recheck of an
   * unchanged offer is therefore AVAILABLE at the stored fare.
   */
  async revalidate(
    dto: RevalidateScheduledDto,
  ): Promise<ScheduledRevalidationDto> {
    const { offer, query } = await this.findOffer(dto.searchId, dto.offerId);
    if (offer.soldOut) return { status: 'SOLD_OUT' };
    const result = await this.callProvider(offer, (provider) =>
      provider.revalidate(
        offer.providerOfferId,
        query.passengers,
        offer.fare.amountMinor,
      ),
    );
    if (
      result === 'GONE' ||
      result.status === 'SOLD_OUT' ||
      !result.offer ||
      result.currentTotalMinor === null
    ) {
      await this.updateOffer(dto.searchId, dto.offerId, { soldOut: true });
      return { status: 'SOLD_OUT' };
    }
    const fare: ScheduledOfferDto['fare'] = {
      amountMinor: result.currentTotalMinor,
      currency: 'INR',
      priceType: 'LIVE_FARE',
      fareFamily: result.offer.fareFamily,
    };
    const validUntil = new Date(
      Math.min(Date.now() + this.ttlMs(), Date.parse(query.validUntil)),
    ).toISOString();
    await this.updateOffer(dto.searchId, dto.offerId, { fare, validUntil });
    return { status: result.status, fare, validUntil };
  }

  /**
   * Changes one stored offer. The row is locked first, so rechecks of
   * different offers in the same search cannot overwrite each other.
   */
  private async updateOffer(
    searchId: string,
    offerId: string,
    change: Partial<StoredOffer>,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Search" WHERE id = ${searchId}::uuid FOR UPDATE`;
      const row = await tx.search.findUniqueOrThrow({
        where: { id: searchId },
        select: { results: true },
      });
      const results = row.results as unknown as StoredOffer[];
      const updated = results.map((entry) =>
        entry.offerId === offerId ? { ...entry, ...change } : entry,
      );
      await tx.search.update({
        where: { id: searchId },
        data: { results: updated as unknown as Prisma.InputJsonValue },
      });
    });
  }

  private ttlMs(): number {
    return this.config.getOrThrow<number>('AIRLINE_OFFER_TTL_MINUTES') * 60_000;
  }

  /**
   * One supplier call with the same timeout as search. An offer the
   * supplier no longer knows is `GONE`; a slow or failing supplier is 503.
   */
  private async callProvider<T>(
    offer: StoredOffer,
    run: (provider: NamedAirlineProvider['provider']) => Promise<T>,
  ): Promise<T | 'GONE'> {
    const named = this.providers.find((p) => p.name === offer.provider);
    if (!named) return 'GONE';
    const [outcome] = await callAll(
      [{ name: named.name, run: () => run(named.provider) }],
      this.config.getOrThrow<number>('AIRLINE_TIMEOUT_MS'),
    );
    if (outcome.status === 'OK') return outcome.value;
    if (
      outcome.status === 'ERROR' &&
      outcome.error instanceof AirlineProviderError &&
      outcome.error.code === 'INVALID_OFFER'
    ) {
      return 'GONE';
    }
    this.logger.warn({ provider: named.name, status: outcome.status });
    throw new AppException(
      'SEARCH_PROVIDER_UNAVAILABLE',
      'The airline did not answer. Try again in a moment.',
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }

  /** A live scheduled search. Unknown, another category or expired: 404. */
  private async find(searchId: string) {
    const search = await this.prisma.search.findUnique({
      where: { id: searchId },
    });
    if (!search || search.category !== ServiceCategory.SCHEDULED_AIRLINE) {
      throw notFound('Search');
    }
    const query = search.preferences as unknown as StoredQuery;
    if (Date.parse(query.validUntil) <= Date.now()) {
      throw notFound('Search');
    }
    return {
      search,
      query,
      results: search.results as unknown as StoredOffer[],
    };
  }

  private async findOffer(searchId: string, offerId: string) {
    const { query, results } = await this.find(searchId);
    const offer = results.find((entry) => entry.offerId === offerId);
    if (!offer) throw notFound('Offer');
    return { offer, query };
  }
}

type Direction = ScheduledOfferDto['direction'];

function toStored(
  provider: string,
  offer: FareOffer,
  direction: Direction,
  from: LocationSummary,
  to: LocationSummary,
  validUntil: string,
): StoredOffer {
  return {
    offerId: randomUUID(),
    provider,
    providerOfferId: offer.offerId,
    carrier: { code: offer.carrierCode, name: offer.carrierName },
    segments: [
      {
        from: summary(from),
        to: summary(to),
        departAt: localIso(offer.departureAt, from.timeZone),
        arriveAt: localIso(offer.arrivalAt, to.timeZone),
        flightNumber: offer.flightNumber,
        durationMinutes: offer.durationMinutes,
      },
    ],
    direction,
    stops: offer.stops,
    fare: {
      amountMinor: offer.totalMinor,
      currency: offer.currency,
      priceType: 'LIVE_FARE',
      fareFamily: offer.fareFamily,
    },
    baggage: {
      cabinKg: offer.baggage.cabinKg,
      checkedKg: offer.baggage.checkedKg,
    },
    refundable: offer.refundable,
    validUntil,
  };
}

function summary(location: LocationSummary): LocationSummary {
  const { id, name, iata, icao, timeZone } = location;
  return { id, name, iata, icao, timeZone };
}

/** Drops the supplier references from each stored offer. */
function response(
  searchId: string,
  passengers: StoredQuery['passengers'],
  providers: ScheduledProviderStatusDto[],
  results: StoredOffer[],
): ScheduledSearchResponseDto {
  return {
    searchId,
    partial: providers.some((p) => p.status !== 'OK'),
    providers,
    passengers: {
      adults: passengers.adults,
      children: passengers.children,
      infants: passengers.infants,
    },
    results: results
      .filter((offer) => !offer.soldOut)
      .map(
        ({
          provider: _provider,
          providerOfferId: _id,
          soldOut: _soldOut,
          ...offer
        }) => offer,
      ),
  };
}

/** Dates are local at the origin: today there at the earliest. */
export function checkDates(
  dto: Pick<ScheduledSearchDto, 'departureDate' | 'returnDate'>,
  today: string,
): void {
  const last = new Date(
    Date.parse(`${today}T00:00:00Z`) + MAX_DAYS_AHEAD * DAY_MS,
  )
    .toISOString()
    .slice(0, 10);
  if (dto.departureDate < today) {
    throw invalid('departureDate', 'must be today or later');
  }
  if (dto.departureDate > last) {
    throw invalid('departureDate', `must be within ${MAX_DAYS_AHEAD} days`);
  }
  if (dto.returnDate !== undefined) {
    if (dto.returnDate < dto.departureDate) {
      throw invalid('returnDate', 'must be on or after departureDate');
    }
    if (dto.returnDate > last) {
      throw invalid('returnDate', `must be within ${MAX_DAYS_AHEAD} days`);
    }
  }
}

/** Nine seats at most per booking; one infant per adult's lap. */
export function checkParty(passengers: ScheduledPassengersDto): void {
  if (passengers.adults + passengers.children > 9) {
    throw invalid(
      'passengers.children',
      'adults and children together must be at most 9',
    );
  }
  if (passengers.infants > passengers.adults) {
    throw invalid('passengers.infants', 'must not be more than adults');
  }
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

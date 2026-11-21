import { randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import type { Redis } from 'ioredis';
import { Paginated } from '../../common/dto/paginated.js';
import { AppException } from '../../common/errors/app.exception.js';
import { uniqueOrNull } from '../../common/errors/unique.js';
import { minorToNumber } from '../../common/money.js';
import { emptyLegReference } from '../../common/reference.js';
import { Prisma } from '../../generated/prisma/client.js';
import {
  AircraftListingStatus,
  EmptyLegStatus,
  NotificationChannel,
  OperatorStatus,
  Role,
  ServiceCategory,
  UserStatus,
} from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { REDIS } from '../../redis/redis.module.js';
import { AircraftService } from '../aircraft/aircraft.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { CategoryConfigService } from '../configuration/category-config.service.js';
import { LocationsService } from '../locations/locations.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import {
  assertCan,
  inScope,
  type OperatorAccess,
} from '../operators/operator-access.js';
import { OperatorsService } from '../operators/operators.service.js';
import { UsersService } from '../users/users.service.js';
import {
  ALTERNATIVE_WINDOW_DAYS,
  BOOKING_ENDED,
  changedFields,
  COMMITTED_FIELDS,
  greatCircleKm,
  EDITABLE,
  type EmptyLegAction,
  LOCKED_WHEN_PUBLISHED,
  MATERIAL_FIELDS,
  nextEmptyLegStatus,
  pickAlternatives,
  type OfferTerms,
  priceTypeOf,
  statusAfterEdit,
  termsIssues,
  type TransitionRefusal,
  WITHDRAWABLE,
} from './empty-leg-rules.js';
import type {
  AdminEmptyLegResponseDto,
  CreateEmptyLegDto,
  EmptyLegResponseDto,
  OperatorEmptyLegResponseDto,
  PublicEmptyLegQueryDto,
  UpdateEmptyLegDto,
} from './dto/empty-leg.dto.js';

/** Listed offers in the date window read before distance narrows them. */
const ALTERNATIVE_CANDIDATES = 200;

const LOCK_KEY = 'empty-legs:expiry:lock';
const LOCK_SECONDS = 5 * 60;
const RELEASE_LOCK = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
/** Offers expired per batch; the job loops until none are left. */
const EXPIRY_BATCH = 100;
/** Offers one operator may hold that are not finished (draft to published). */
const MAX_OPEN_OFFERS = 200;

const LOCATION_SELECT = {
  id: true,
  name: true,
  city: true,
  iata: true,
  icao: true,
  timeZone: true,
} as const;

/** The API's names for the offer's columns, in error details. */
const API_FIELD: Record<string, string> = {
  aircraftId: 'aircraftId',
  originId: 'originId',
  destinationId: 'destinationId',
  priceMinor: 'priceMinor',
  departureWindowStart: 'departureFrom',
  departureWindowEnd: 'departureTo',
  passengerCapacity: 'seatsAvailable',
  expiresAt: 'validUntil',
  bookingConditions: 'conditions',
};

/**
 * Read-only joins for display, as in the aircraft lists (D-066): the
 * aircraft's type and seats, the operator's name and the two locations.
 * Every write to those tables stays in its own module.
 */
const OFFER_INCLUDE = {
  aircraft: {
    select: {
      id: true,
      registration: true,
      manufacturer: true,
      model: true,
      category: true,
      passengerCapacity: true,
      listingStatus: true,
    },
  },
  operator: { select: { legalName: true, tradingName: true } },
  origin: { select: LOCATION_SELECT },
  destination: { select: LOCATION_SELECT },
  _count: {
    select: {
      interests: true,
      // Live booking requests (M8-C): at most one, by the partial index.
      bookings: { where: { status: { notIn: BOOKING_ENDED } } },
    },
  },
} satisfies Prisma.EmptyLegInclude;

type OfferRow = Prisma.EmptyLegGetPayload<{ include: typeof OFFER_INCLUDE }>;

/** What a booking copies from the offer it is made from (M8-C). */
export interface BookableOffer {
  id: string;
  reference: string;
  operatorId: string;
  operatorName: string;
  aircraft: {
    id: string;
    manufacturer: string;
    model: string;
    category: OfferRow['aircraft']['category'];
    passengerCapacity: number;
  };
  origin: { id: string; name: string };
  destination: { id: string; name: string };
  departureFrom: Date;
  departureTo: Date;
  seatsAvailable: number;
  priceMinor: bigint;
  currency: string;
  priceType: ReturnType<typeof priceTypeOf>;
  expiresAt: Date;
  conditions: string;
  /** The version the customer read (`offerUpdatedAt`). */
  updatedAt: Date;
  /** Great-circle kilometres, rounded; null when a location has no position. */
  distanceKm: number | null;
}

/** A trip end as `alternativesFor` compares it. */
type TripPoint = { id: string; latitude: number; longitude: number };

function notFound(): AppException {
  return new AppException(
    'NOT_FOUND',
    'Empty leg not found.',
    HttpStatus.NOT_FOUND,
  );
}

function invalid(
  issues: { field: string; issue: string }[],
  message = 'Check the offer and try again.',
): AppException {
  return new AppException(
    'VALIDATION_ERROR',
    message,
    HttpStatus.BAD_REQUEST,
    issues,
  );
}

function refusal(reason: TransitionRefusal, action: string): AppException {
  if (reason === 'role') {
    return new AppException(
      'FORBIDDEN',
      'You do not have permission to do this.',
      HttpStatus.FORBIDDEN,
    );
  }
  if (reason === 'reason') {
    return invalid(
      [{ field: 'reason', issue: 'is required' }],
      'A reason is required.',
    );
  }
  return new AppException(
    'EMPTY_LEG_INVALID_TRANSITION',
    `This offer cannot be ${action} in its current status.`,
    HttpStatus.CONFLICT,
  );
}

function terms(row: OfferTerms): OfferTerms {
  return {
    aircraftId: row.aircraftId,
    originId: row.originId,
    destinationId: row.destinationId,
    departureWindowStart: row.departureWindowStart,
    departureWindowEnd: row.departureWindowEnd,
    passengerCapacity: row.passengerCapacity,
    priceMinor: row.priceMinor,
    expiresAt: row.expiresAt,
    bookingConditions: row.bookingConditions,
  };
}

/** What an audit record keeps of an offer: no customer data. */
function snapshot(row: OfferTerms & { status: EmptyLegStatus }) {
  return {
    status: row.status,
    aircraftId: row.aircraftId,
    originId: row.originId,
    destinationId: row.destinationId,
    departureWindowStart: row.departureWindowStart.toISOString(),
    departureWindowEnd: row.departureWindowEnd.toISOString(),
    passengerCapacity: row.passengerCapacity,
    priceMinor: minorToNumber(row.priceMinor),
    expiresAt: row.expiresAt.toISOString(),
    bookingConditions: row.bookingConditions,
  };
}

/** India's midnight at the start of `day` (YYYY-MM-DD), as UTC. */
function indiaDayStart(day: string, plusDays = 0): Date {
  return new Date(Date.parse(`${day}T00:00:00+05:30`) + plusDays * 86_400_000);
}

function routeLabel(row: OfferRow): string {
  const place = (l: OfferRow['origin']) =>
    l.iata ? `${l.city ?? l.name} (${l.iata})` : (l.city ?? l.name);
  return `${place(row.origin)} → ${place(row.destination)}`;
}

/**
 * Empty-leg offers (M7): operator create, edit, publish and withdraw;
 * optional review by operations (EMPTY_LEG_REVIEW_REQUIRED); the public
 * listing; customers' interest; and the expiry job. Owns EmptyLeg and
 * EmptyLegInterest.
 */
@Injectable()
export class EmptyLegsService {
  private readonly logger = new Logger(EmptyLegsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly operators: OperatorsService,
    private readonly aircraft: AircraftService,
    private readonly locations: LocationsService,
    private readonly users: UsersService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly categories: CategoryConfigService,
  ) {}

  private get reviewRequired(): boolean {
    return this.config.get<boolean>('EMPTY_LEG_REVIEW_REQUIRED') === true;
  }

  // --- Mapping -------------------------------------------------------------

  toPublic(row: OfferRow): EmptyLegResponseDto {
    return {
      id: row.id,
      reference: row.reference,
      status: row.status,
      aircraft: {
        type: `${row.aircraft.manufacturer} ${row.aircraft.model}`,
        category: row.aircraft.category,
        seats: row.aircraft.passengerCapacity,
      },
      operatorName: row.operator.tradingName ?? row.operator.legalName,
      origin: row.origin,
      destination: row.destination,
      departureFrom: row.departureWindowStart.toISOString(),
      departureTo: row.departureWindowEnd.toISOString(),
      seatsAvailable: row.passengerCapacity,
      price: {
        amountMinor: minorToNumber(row.priceMinor),
        currency: row.currency,
        priceType: priceTypeOf(row.pricingBasis),
      },
      validUntil: row.expiresAt.toISOString(),
      conditions: row.bookingConditions,
    };
  }

  toOperator(row: OfferRow): OperatorEmptyLegResponseDto {
    const base = this.toPublic(row);
    return {
      ...base,
      aircraft: {
        ...base.aircraft,
        id: row.aircraft.id,
        registration: row.aircraft.registration,
      },
      reviewNote: row.reviewNote,
      submittedAt: row.submittedAt?.toISOString() ?? null,
      publishedAt: row.publishedAt?.toISOString() ?? null,
      interestCount: row._count.interests,
      editable: EDITABLE.includes(row.status),
      publishable: row.status === EmptyLegStatus.DRAFT,
      withdrawable:
        WITHDRAWABLE.includes(row.status) && row._count.bookings === 0,
      hasLiveRequest: row._count.bookings > 0,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  toAdmin(row: OfferRow): AdminEmptyLegResponseDto {
    return { ...this.toOperator(row), operatorId: row.operatorId };
  }

  // --- Public listing ------------------------------------------------------

  /**
   * What makes an offer listed (rules 4 and 7): published, still valid, and
   * on an aircraft search would offer, of an approved operator. Checked at
   * read time, so nothing stale shows between expiry runs and a suspension
   * hides offers at once.
   */
  private listedWhere(now = new Date()): Prisma.EmptyLegWhereInput {
    return {
      status: EmptyLegStatus.PUBLISHED,
      expiresAt: { gt: now },
      aircraft: this.aircraft.bookableWhere(now),
      // An offer someone has requested is off the list until that booking
      // ends (M8-C); a read-only join, as for display (D-066).
      bookings: { none: { status: { notIn: BOOKING_ENDED } } },
    };
  }

  /**
   * The offer a customer is booking (M8-C), locked (`FOR UPDATE`) for the
   * caller's transaction so two bookings of it are made one after the
   * other. Listed (rule 4: published, valid, approved operator and
   * aircraft, no live booking) and not yet in its departure window, read
   * after the lock; otherwise null, which the caller answers as
   * unavailable. The live-booking check is the caller's, under this lock.
   */
  async forBooking(
    tx: Prisma.TransactionClient,
    id: string,
    now: Date,
  ): Promise<BookableOffer | null> {
    await tx.$queryRaw`SELECT 1 FROM "EmptyLeg" WHERE "id" = ${id}::uuid FOR UPDATE`;
    const { bookings: _live, ...listed } = this.listedWhere(now);
    const row = await tx.emptyLeg.findFirst({
      where: { id, ...listed, departureWindowStart: { gt: now } },
      include: OFFER_INCLUDE,
    });
    if (!row) return null;
    const points = await this.locations.pricingPoints([
      row.originId,
      row.destinationId,
    ]);
    const from = points.get(row.originId);
    const to = points.get(row.destinationId);
    return {
      id: row.id,
      reference: row.reference,
      operatorId: row.operatorId,
      operatorName: row.operator.tradingName ?? row.operator.legalName,
      aircraft: {
        id: row.aircraft.id,
        manufacturer: row.aircraft.manufacturer,
        model: row.aircraft.model,
        category: row.aircraft.category,
        passengerCapacity: row.aircraft.passengerCapacity,
      },
      origin: { id: row.origin.id, name: row.origin.name },
      destination: { id: row.destination.id, name: row.destination.name },
      departureFrom: row.departureWindowStart,
      departureTo: row.departureWindowEnd,
      seatsAvailable: row.passengerCapacity,
      priceMinor: row.priceMinor,
      currency: row.currency,
      priceType: priceTypeOf(row.pricingBasis),
      expiresAt: row.expiresAt,
      conditions: row.bookingConditions,
      updatedAt: row.updatedAt,
      distanceKm: from && to ? Math.round(greatCircleKm(from, to)) : null,
    };
  }

  /**
   * A booking of the offer was confirmed: the offer becomes `BOOKED`
   * (from `PUBLISHED`, or `EXPIRED` when the job closed it meanwhile),
   * audited as the system's act. Runs inside the confirmation's
   * transaction, which must never fail for it: an offer in any other
   * status (withdrawn, already booked) is left as it is.
   */
  async markBooked(tx: Prisma.TransactionClient, id: string): Promise<void> {
    const row = await tx.emptyLeg.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!row) return;
    const next = nextEmptyLegStatus('book', row.status, null);
    if (!('to' in next)) return;
    const { count } = await tx.emptyLeg.updateMany({
      where: { id, status: row.status },
      data: { status: next.to },
    });
    if (count !== 1) return;
    await this.audit.record(
      {
        action: 'empty_leg.book',
        entityType: 'EmptyLeg',
        entityId: id,
        before: { status: row.status },
        after: { status: next.to },
        actor: null,
      },
      tx,
    );
  }

  async publicList(
    query: PublicEmptyLegQueryDto,
  ): Promise<Paginated<OfferRow>> {
    // Nothing is listed while empty legs are switched off (M10).
    if (!(await this.categories.isEnabled(ServiceCategory.EMPTY_LEG))) {
      return new Paginated([], query.page, query.pageSize, 0);
    }
    const where: Prisma.EmptyLegWhereInput = {
      AND: [
        this.listedWhere(),
        query.origin ? { originId: query.origin } : {},
        query.destination ? { destinationId: query.destination } : {},
        query.from
          ? { departureWindowEnd: { gte: indiaDayStart(query.from) } }
          : {},
        query.to
          ? { departureWindowStart: { lt: indiaDayStart(query.to, 1) } }
          : {},
        query.passengers
          ? { passengerCapacity: { gte: query.passengers } }
          : {},
        query.maxPrice ? { priceMinor: { lte: BigInt(query.maxPrice) } } : {},
      ],
    };
    const [rows, total] = await Promise.all([
      this.prisma.emptyLeg.findMany({
        where,
        include: OFFER_INCLUDE,
        orderBy: [{ departureWindowStart: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.emptyLeg.count({ where }),
    ]);
    return new Paginated(rows, query.page, query.pageSize, total);
  }

  /**
   * Listed offers that could stand in for a charter search (M7): the same or
   * a nearby origin and destination, leaving within a few days of the
   * requested departure, with enough seats. Only what is listed (rule 4);
   * each carries its own `priceType` (rule 1). Empty when the places are
   * unknown.
   */
  async alternativesFor(trip: {
    originId: string;
    destinationId: string;
    departureAt: Date;
    passengers: number;
    /** The trip's ends when the caller has already read them (search). */
    points?: { origin: TripPoint; destination: TripPoint };
  }): Promise<EmptyLegResponseDto[]> {
    const places = trip.points
      ? null
      : await this.locations.pricingPoints([trip.originId, trip.destinationId]);
    const origin = trip.points?.origin ?? places?.get(trip.originId);
    const destination =
      trip.points?.destination ?? places?.get(trip.destinationId);
    if (!origin || !destination) return [];
    const span = ALTERNATIVE_WINDOW_DAYS * 86_400_000;
    const at = trip.departureAt.getTime();
    const rows = await this.prisma.emptyLeg.findMany({
      where: {
        AND: [
          this.listedWhere(),
          { passengerCapacity: { gte: trip.passengers } },
          { departureWindowEnd: { gte: new Date(at - span) } },
          { departureWindowStart: { lte: new Date(at + span) } },
        ],
      },
      include: OFFER_INCLUDE,
      orderBy: [{ departureWindowStart: 'asc' }, { id: 'asc' }],
      take: ALTERNATIVE_CANDIDATES,
    });
    const coordinates = await this.locations.pricingPoints([
      ...new Set(rows.flatMap((r) => [r.originId, r.destinationId])),
    ]);
    const known = rows.flatMap((row) => {
      const from = coordinates.get(row.originId);
      const to = coordinates.get(row.destinationId);
      return from && to ? [{ row, origin: from, destination: to }] : [];
    });
    return pickAlternatives(
      known.map((k) => ({
        ...k,
        departureWindowStart: k.row.departureWindowStart,
        departureWindowEnd: k.row.departureWindowEnd,
        passengerCapacity: k.row.passengerCapacity,
      })),
      {
        origin,
        destination,
        departureAt: trip.departureAt,
        passengers: trip.passengers,
        now: new Date(),
      },
    ).map((k) => this.toPublic(k.row));
  }

  /**
   * A listed offer, or why not: 410 when it was public and has ended
   * (expired or withdrawn), 404 when it was never public or is hidden.
   */
  async listed(id: string): Promise<OfferRow> {
    // Hidden while empty legs are switched off (M10).
    if (!(await this.categories.isEnabled(ServiceCategory.EMPTY_LEG))) {
      throw notFound();
    }
    const row = await this.prisma.emptyLeg.findFirst({
      where: { id, ...this.listedWhere() },
      include: OFFER_INCLUDE,
    });
    if (row) return row;
    const ended = await this.prisma.emptyLeg.findUnique({
      where: { id },
      select: { status: true, expiresAt: true, publishedAt: true },
    });
    if (ended?.status === EmptyLegStatus.WITHDRAWN && ended.publishedAt) {
      throw new AppException(
        'EMPTY_LEG_WITHDRAWN',
        'This offer has been withdrawn by the operator.',
        HttpStatus.GONE,
      );
    }
    if (
      ended &&
      ended.publishedAt &&
      (ended.status === EmptyLegStatus.EXPIRED ||
        (ended.status === EmptyLegStatus.PUBLISHED &&
          ended.expiresAt <= new Date()))
    ) {
      throw new AppException(
        'EMPTY_LEG_EXPIRED',
        'This offer has expired.',
        HttpStatus.GONE,
      );
    }
    throw notFound();
  }

  // --- Interest ------------------------------------------------------------

  /** Registers the customer for change alerts on a listed offer. Repeatable. */
  async registerInterest(user: AuthUser, id: string): Promise<void> {
    await this.listed(id);
    await uniqueOrNull(() =>
      this.prisma.emptyLegInterest.create({
        data: { emptyLegId: id, userId: user.id },
      }),
    );
  }

  /** Stops alerts. Repeatable; succeeds when there was nothing to remove. */
  async removeInterest(user: AuthUser, id: string): Promise<void> {
    await this.prisma.emptyLegInterest.deleteMany({
      where: { emptyLegId: id, userId: user.id },
    });
  }

  /**
   * Erasure (privacy module): forgets every offer the customer asked to be
   * alerted about, in the caller's transaction.
   */
  async forgetInterests(
    userId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const { count } = await tx.emptyLegInterest.deleteMany({
      where: { userId },
    });
    return count;
  }

  // --- Operator ------------------------------------------------------------

  private async scope(
    user: AuthUser,
  ): Promise<{ status: OperatorStatus; access: OperatorAccess }> {
    const { operator, access } = await this.operators.accessFor(user);
    assertCan(access, 'MANAGE_EMPTY_LEGS');
    return { status: operator.status, access };
  }

  /** Changing offers needs an approved operator (state-machines.md). */
  private assertApproved(status: OperatorStatus): void {
    if (status !== OperatorStatus.APPROVED) {
      throw new AppException(
        'OPERATOR_NOT_APPROVED',
        'Only an approved operator can offer empty legs.',
        HttpStatus.CONFLICT,
      );
    }
  }

  private ownWhere(access: OperatorAccess): Prisma.EmptyLegWhereInput {
    return access.aircraft === 'ALL'
      ? { operatorId: access.operatorId }
      : { operatorId: access.operatorId, aircraftId: { in: access.aircraft } };
  }

  /** One of the caller's offers, on an aircraft in their reach, or 404. */
  private async own(access: OperatorAccess, id: string): Promise<OfferRow> {
    const row = await this.prisma.emptyLeg.findFirst({
      where: { id, ...this.ownWhere(access) },
      include: OFFER_INCLUDE,
    });
    if (!row) throw notFound();
    return row;
  }

  async operatorList(
    user: AuthUser,
    query: { page: number; pageSize: number; status?: EmptyLegStatus },
  ): Promise<Paginated<OfferRow>> {
    const { access } = await this.scope(user);
    const where = { ...this.ownWhere(access), status: query.status };
    const [rows, total] = await Promise.all([
      this.prisma.emptyLeg.findMany({
        where,
        include: OFFER_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.emptyLeg.count({ where }),
    ]);
    return new Paginated(rows, query.page, query.pageSize, total);
  }

  /**
   * Approved aircraft in the caller's reach, to choose from when creating
   * an offer. Lets staff with only "manage empty legs" pick an aircraft
   * without any access to the fleet routes.
   */
  async aircraftOptions(user: AuthUser) {
    const { access } = await this.scope(user);
    const fleet = await this.aircraft.fleetFor(access);
    return fleet
      .filter((row) => row.listingStatus === AircraftListingStatus.APPROVED)
      .map((row) => ({
        id: row.id,
        registration: row.registration,
        type: `${row.manufacturer} ${row.model}`,
        category: row.category,
        seats: row.passengerCapacity,
      }));
  }

  /** Whether the customer follows the offer. */
  async isInterested(userId: string, id: string): Promise<boolean> {
    const row = await this.prisma.emptyLegInterest.findUnique({
      where: { emptyLegId_userId: { emptyLegId: id, userId } },
      select: { id: true },
    });
    return row !== null;
  }

  async operatorGet(user: AuthUser, id: string): Promise<OfferRow> {
    const { access } = await this.scope(user);
    return this.own(access, id);
  }

  /** Validates terms against the aircraft and the locations. */
  private async checkTerms(
    access: OperatorAccess,
    next: OfferTerms,
    changed: { aircraft: boolean; origin: boolean; destination: boolean },
  ): Promise<void> {
    const aircraft = await this.aircraft.inReach(access, next.aircraftId);
    const issues = termsIssues(next, aircraft.passengerCapacity, new Date());
    for (const [field, id, check] of [
      ['originId', next.originId, changed.origin],
      ['destinationId', next.destinationId, changed.destination],
    ] as const) {
      if (check && !(await this.locations.isActive(id))) {
        issues.push({ field, issue: 'is not an active location' });
      }
    }
    if (issues.length > 0) throw invalid(issues);
  }

  async create(user: AuthUser, dto: CreateEmptyLegDto): Promise<OfferRow> {
    const { status, access } = await this.scope(user);
    this.assertApproved(status);
    const next: OfferTerms = {
      aircraftId: dto.aircraftId,
      originId: dto.originId,
      destinationId: dto.destinationId,
      departureWindowStart: new Date(dto.departureFrom),
      departureWindowEnd: new Date(dto.departureTo),
      passengerCapacity: dto.seatsAvailable,
      priceMinor: BigInt(dto.priceMinor),
      expiresAt: new Date(dto.validUntil),
      bookingConditions: dto.conditions,
    };
    if (!inScope(access, next.aircraftId)) throw notFound();
    await this.checkTerms(access, next, {
      aircraft: true,
      origin: true,
      destination: true,
    });
    const open = await this.prisma.emptyLeg.count({
      where: {
        operatorId: access.operatorId,
        status: {
          in: [
            EmptyLegStatus.DRAFT,
            EmptyLegStatus.PENDING_REVIEW,
            EmptyLegStatus.PUBLISHED,
          ],
        },
      },
    });
    if (open >= MAX_OPEN_OFFERS) {
      throw new AppException(
        'EMPTY_LEG_LIMIT_REACHED',
        `An operator can hold at most ${MAX_OPEN_OFFERS} open offers. Withdraw some first.`,
        HttpStatus.CONFLICT,
      );
    }
    // A reference clash (31^6 codes) draws again.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const id = await uniqueOrNull(() =>
        this.prisma.$transaction(async (tx) => {
          const row = await tx.emptyLeg.create({
            data: {
              ...next,
              reference: emptyLegReference(),
              operatorId: access.operatorId,
              createdById: user.id,
            },
          });
          await this.audit.record(
            {
              action: 'empty_leg.create',
              entityType: 'EmptyLeg',
              entityId: row.id,
              after: snapshot(row),
            },
            tx,
          );
          return row.id;
        }),
      );
      if (id) return this.own(access, id);
    }
    throw new Error('Could not draw a unique empty-leg reference');
  }

  async update(
    user: AuthUser,
    id: string,
    dto: UpdateEmptyLegDto,
  ): Promise<OfferRow> {
    const { status, access } = await this.scope(user);
    const current = await this.own(access, id);
    this.assertApproved(status);
    if (!EDITABLE.includes(current.status)) {
      throw refusal('state', 'changed');
    }
    const before = terms(current);
    const next: OfferTerms = {
      aircraftId: dto.aircraftId ?? before.aircraftId,
      originId: dto.originId ?? before.originId,
      destinationId: dto.destinationId ?? before.destinationId,
      departureWindowStart: dto.departureFrom
        ? new Date(dto.departureFrom)
        : before.departureWindowStart,
      departureWindowEnd: dto.departureTo
        ? new Date(dto.departureTo)
        : before.departureWindowEnd,
      passengerCapacity: dto.seatsAvailable ?? before.passengerCapacity,
      priceMinor:
        dto.priceMinor !== undefined
          ? BigInt(dto.priceMinor)
          : before.priceMinor,
      expiresAt: dto.validUntil ? new Date(dto.validUntil) : before.expiresAt,
      bookingConditions: dto.conditions ?? before.bookingConditions,
    };
    if (current.status === EmptyLegStatus.PUBLISHED) {
      const locked = changedFields(before, next, LOCKED_WHEN_PUBLISHED);
      if (locked.length > 0) {
        throw new AppException(
          'EMPTY_LEG_FIELD_LOCKED',
          'The aircraft and route of a published offer cannot change. Withdraw it and create another.',
          HttpStatus.CONFLICT,
          locked.map((field) => ({ field, issue: 'is locked once published' })),
        );
      }
    }
    if (!inScope(access, next.aircraftId)) throw notFound();
    const material = changedFields(before, next, MATERIAL_FIELDS);
    const moved = changedFields(before, next, LOCKED_WHEN_PUBLISHED);
    if (material.length === 0 && moved.length === 0) return current;
    await this.checkTerms(access, next, {
      aircraft: moved.includes('aircraftId'),
      origin: moved.includes('originId'),
      destination: moved.includes('destinationId'),
    });

    const to = statusAfterEdit(current.status, this.reviewRequired);
    // Customers hear of a change to a listed offer at once; when it goes
    // back to review they hear on approval instead.
    const notify = to === EmptyLegStatus.PUBLISHED;
    const committed = changedFields(before, next, COMMITTED_FIELDS);
    const queued = await this.prisma.$transaction(async (tx) => {
      if (committed.length > 0) {
        await this.assertNoLiveRequest(tx, id, committed);
      }
      const { count } = await tx.emptyLeg.updateMany({
        where: { id, status: current.status, updatedAt: current.updatedAt },
        data: {
          ...next,
          status: to,
          ...(to !== current.status
            ? { submittedAt: new Date(), reviewNote: null }
            : {}),
        },
      });
      if (count !== 1) throw this.stale();
      const row = await tx.emptyLeg.findUniqueOrThrow({ where: { id } });
      await this.audit.record(
        {
          action: 'empty_leg.update',
          entityType: 'EmptyLeg',
          entityId: id,
          before: snapshot(current),
          after: snapshot(row),
        },
        tx,
      );
      return notify
        ? this.enqueueInterested(tx, current, 'empty_leg.changed')
        : [];
    });
    await this.deliverAll(queued);
    return this.own(access, id);
  }

  /**
   * 409 `EMPTY_LEG_HAS_LIVE_REQUEST` while a customer's booking request for
   * the offer is live (M8-C): its terms (`COMMITTED_FIELDS`) and the offer
   * itself are what the customer asked for. Under the offer's row lock, which a
   * booking request takes too (`forBooking`), so neither slips past the
   * other. `fields` names what the caller would change.
   */
  private async assertNoLiveRequest(
    tx: Prisma.TransactionClient,
    id: string,
    fields: string[] = [],
  ): Promise<void> {
    await tx.$queryRaw`SELECT 1 FROM "EmptyLeg" WHERE "id" = ${id}::uuid FOR UPDATE`;
    const live = await tx.booking.count({
      where: { emptyLegId: id, status: { notIn: BOOKING_ENDED } },
    });
    if (live === 0) return;
    throw new AppException(
      'EMPTY_LEG_HAS_LIVE_REQUEST',
      fields.length > 0
        ? 'A customer has requested this offer, so its aircraft, route, departure window, seats, price, validity and conditions cannot change until that request is answered. Answer it under Requests first.'
        : 'A customer has requested this offer, so it cannot be withdrawn until that request is answered. Answer it under Requests first.',
      HttpStatus.CONFLICT,
      fields.map((field) => ({
        field: API_FIELD[field] ?? field,
        issue: 'is fixed while a booking request is live',
      })),
    );
  }

  private stale(): AppException {
    return new AppException(
      'EMPTY_LEG_INVALID_TRANSITION',
      'This offer was changed by someone else. Reload it and try again.',
      HttpStatus.CONFLICT,
    );
  }

  async publish(user: AuthUser, id: string): Promise<OfferRow> {
    const { status, access } = await this.scope(user);
    const current = await this.own(access, id);
    this.assertApproved(status);
    const next = nextEmptyLegStatus('publish', current.status, user.role, {
      reviewRequired: this.reviewRequired,
    });
    if ('refused' in next) throw refusal(next.refused, 'published');
    await this.assertPublishable(current);
    await this.move(current, 'publish', next.to, {
      submittedAt: new Date(),
      reviewNote: null,
      reviewedById: null,
      reviewedAt: null,
      ...(next.to === EmptyLegStatus.PUBLISHED
        ? { publishedAt: new Date() }
        : {}),
    });
    return this.own(access, id);
  }

  /**
   * Rules 4 and 7 at publication and approval: an approved aircraft of an
   * approved operator, and validity still ahead.
   */
  private async assertPublishable(row: OfferRow): Promise<void> {
    const status = await this.operators.statusOf(row.operatorId);
    if (status !== OperatorStatus.APPROVED) this.assertApproved(status);
    if (row.aircraft.listingStatus !== AircraftListingStatus.APPROVED) {
      throw new AppException(
        'AIRCRAFT_NOT_APPROVED',
        'Only an approved aircraft can be offered.',
        HttpStatus.CONFLICT,
      );
    }
    const issues = termsIssues(
      terms(row),
      row.aircraft.passengerCapacity,
      new Date(),
    );
    if (issues.length === 0) return;
    // Time has run out on the offer: 410. Anything else (seats above a
    // capacity lowered since) is a plain validation error.
    if (!issues.every((issue) => issue.issue === 'must be in the future')) {
      throw invalid(issues);
    }
    throw new AppException(
      'EMPTY_LEG_EXPIRED',
      'The offer has passed its validity or departure. Update the dates first.',
      HttpStatus.GONE,
      issues,
    );
  }

  async withdraw(user: AuthUser, id: string): Promise<OfferRow> {
    const { access } = await this.scope(user);
    const current = await this.own(access, id);
    const next = nextEmptyLegStatus('withdraw', current.status, user.role);
    if ('refused' in next) throw refusal(next.refused, 'withdrawn');
    await this.move(current, 'withdraw', next.to, {});
    return this.own(access, id);
  }

  // --- Admin ---------------------------------------------------------------

  async adminList(query: {
    page: number;
    pageSize: number;
    status?: EmptyLegStatus;
    operatorId?: string;
  }): Promise<Paginated<OfferRow>> {
    const where: Prisma.EmptyLegWhereInput = {
      status: query.status,
      operatorId: query.operatorId,
    };
    const [rows, total] = await Promise.all([
      this.prisma.emptyLeg.findMany({
        where,
        include: OFFER_INCLUDE,
        // Oldest submission first, so the review queue is first come, first served.
        orderBy: [
          { submittedAt: { sort: 'asc', nulls: 'last' } },
          { createdAt: 'desc' },
          { id: 'asc' },
        ],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.emptyLeg.count({ where }),
    ]);
    return new Paginated(rows, query.page, query.pageSize, total);
  }

  private async adminGet(id: string): Promise<OfferRow> {
    const row = await this.prisma.emptyLeg.findUnique({
      where: { id },
      include: OFFER_INCLUDE,
    });
    if (!row) throw notFound();
    return row;
  }

  async review(
    actor: AuthUser,
    id: string,
    action: 'approve' | 'reject',
    reason?: string,
  ): Promise<OfferRow> {
    const current = await this.adminGet(id);
    const next = nextEmptyLegStatus(action, current.status, actor.role, {
      reason,
    });
    if ('refused' in next) {
      throw refusal(
        next.refused,
        action === 'approve' ? 'approved' : 'rejected',
      );
    }
    if (action === 'approve') await this.assertPublishable(current);
    const decided = {
      reviewedById: actor.id,
      reviewedAt: new Date(),
      reviewNote: action === 'reject' ? reason!.trim() : null,
    };
    await this.move(
      current,
      action,
      next.to,
      action === 'approve' ? { ...decided, publishedAt: new Date() } : decided,
      reason?.trim(),
    );
    const row = await this.adminGet(id);
    await this.notifyOperator(row, action, reason?.trim());
    return row;
  }

  // --- Transitions ---------------------------------------------------------

  /**
   * Moves an offer's status (compare-and-set on the status read), audits it
   * and queues the customer alerts it causes, in one transaction; delivers
   * after the commit.
   */
  private async move(
    current: OfferRow,
    action: EmptyLegAction,
    to: EmptyLegStatus,
    extra: Prisma.EmptyLegUpdateManyMutationInput,
    reason?: string,
    actor?: null,
  ): Promise<boolean> {
    const template =
      action === 'withdraw' && current.status === EmptyLegStatus.PUBLISHED
        ? 'empty_leg.withdrawn'
        : action === 'expire' && current.status === EmptyLegStatus.PUBLISHED
          ? 'empty_leg.expired'
          : // Approval of an offer that was listed before (edited under review).
            action === 'approve' && current.publishedAt
            ? 'empty_leg.changed'
            : null;
    const queued = await this.prisma.$transaction(async (tx) => {
      if (action === 'withdraw') await this.assertNoLiveRequest(tx, current.id);
      const { count } = await tx.emptyLeg.updateMany({
        where: { id: current.id, status: current.status },
        data: { ...extra, status: to },
      });
      if (count !== 1) return null;
      await this.audit.record(
        {
          action: `empty_leg.${action}`,
          entityType: 'EmptyLeg',
          entityId: current.id,
          before: { status: current.status },
          after: { status: to },
          reason,
          ...(actor === null ? { actor: null } : {}),
        },
        tx,
      );
      return template ? this.enqueueInterested(tx, current, template) : [];
    });
    if (queued === null) {
      if (action === 'expire') return false;
      throw this.stale();
    }
    await this.deliverAll(queued);
    return true;
  }

  /** Queues an alert to every active customer following the offer. */
  private async enqueueInterested(
    tx: Prisma.TransactionClient,
    row: OfferRow,
    templateKey: string,
  ): Promise<string[]> {
    const interests = await tx.emptyLegInterest.findMany({
      where: { emptyLegId: row.id },
      select: { userId: true },
    });
    if (interests.length === 0) return [];
    const accounts = await this.users.summaries(
      interests.map((interest) => interest.userId),
    );
    const variables = { route: routeLabel(row), reference: row.reference };
    const ids: string[] = [];
    for (const [userId, account] of accounts) {
      if (account.status !== UserStatus.ACTIVE) continue;
      if (account.role !== Role.CUSTOMER) continue;
      ids.push(
        await this.notifications.enqueue(
          {
            userId,
            channel: NotificationChannel.IN_APP,
            templateKey,
            variables,
          },
          tx,
        ),
      );
      if (account.email) {
        ids.push(
          await this.notifications.enqueue(
            {
              userId,
              channel: NotificationChannel.EMAIL,
              to: account.email,
              templateKey,
              variables,
            },
            tx,
          ),
        );
      }
    }
    await tx.emptyLegInterest.updateMany({
      where: { emptyLegId: row.id },
      data: { notifiedAt: new Date() },
    });
    return ids;
  }

  /** Sends queued messages now; the outbox retries any that fail. */
  private async deliverAll(ids: string[]): Promise<void> {
    for (const id of ids) await this.notifications.deliver(id);
  }

  private async notifyOperator(
    row: OfferRow,
    action: 'approve' | 'reject',
    reason?: string,
  ): Promise<void> {
    const administrators = await this.operators.administrators(row.operatorId);
    const templateKey =
      action === 'approve' ? 'empty_leg.approved' : 'empty_leg.rejected';
    const variables = {
      route: routeLabel(row),
      reference: row.reference,
      reason: reason ?? '',
    };
    for (const administrator of administrators) {
      await this.notifications.send({
        userId: administrator.id,
        channel: NotificationChannel.IN_APP,
        templateKey,
        variables,
      });
      if (action === 'reject' && administrator.email) {
        await this.notifications.send({
          userId: administrator.id,
          channel: NotificationChannel.EMAIL,
          to: administrator.email,
          templateKey,
          variables,
        });
      }
    }
  }

  // --- Expiry job ----------------------------------------------------------

  /** Every five minutes. */
  @Cron('*/5 * * * *', { name: 'empty-legs-expire' })
  async scheduled(): Promise<void> {
    try {
      await this.runExpiry();
    } catch (error) {
      this.logger.error(
        `Empty-leg expiry failed: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
    }
  }

  /**
   * Marks every open offer past its validity `EXPIRED`, audits it, and tells
   * customers following a listed one. One instance at a time (Redis lock);
   * `skipped` when another run holds it.
   */
  async runExpiry(
    now = new Date(),
  ): Promise<{ expired: number; skipped: boolean }> {
    const token = randomUUID();
    const locked = await this.redis.set(
      LOCK_KEY,
      token,
      'EX',
      LOCK_SECONDS,
      'NX',
    );
    if (!locked) return { expired: 0, skipped: true };
    let expired = 0;
    try {
      const seen = new Set<string>();
      for (;;) {
        const due = await this.prisma.emptyLeg.findMany({
          where: {
            id: { notIn: [...seen] },
            status: {
              in: [
                EmptyLegStatus.DRAFT,
                EmptyLegStatus.PENDING_REVIEW,
                EmptyLegStatus.PUBLISHED,
              ],
            },
            expiresAt: { lte: now },
          },
          include: OFFER_INCLUDE,
          orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
          take: EXPIRY_BATCH,
        });
        for (const row of due) {
          seen.add(row.id);
          const next = nextEmptyLegStatus('expire', row.status, null);
          if ('refused' in next) continue;
          // One offer's failure never stops the others; the next run retries it.
          try {
            if (await this.move(row, 'expire', next.to, {}, undefined, null)) {
              expired += 1;
            }
          } catch (error) {
            this.logger.error(
              `Empty-leg expiry failed for one offer: ${error instanceof Error ? error.name : 'unknown error'}`,
            );
          }
        }
        if (due.length < EXPIRY_BATCH) break;
      }
      if (expired > 0) this.logger.log(`Empty legs expired: ${expired}`);
      return { expired, skipped: false };
    } finally {
      await this.redis.eval(RELEASE_LOCK, 1, LOCK_KEY, token);
    }
  }
}

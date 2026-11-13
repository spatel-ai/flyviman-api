import { HttpStatus, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Paginated } from '../../common/dto/paginated.js';
import { AppException } from '../../common/errors/app.exception.js';
import { uniqueOrNull } from '../../common/errors/unique.js';
import { jsonEqual } from '../../common/json-equal.js';
import { Prisma, type Aircraft } from '../../generated/prisma/client.js';
import {
  AircraftAvailabilityStatus,
  AircraftCategory,
  AircraftDocumentType,
  AircraftListingStatus,
  AircraftMediaKind,
  DocumentVerificationStatus,
  FilePurpose,
  OperatorStatus,
  Role,
  WingType,
} from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { DocumentsService } from '../documents/documents.service.js';
import { LocationsService } from '../locations/locations.service.js';
import { assertDocumentDates } from '../../common/document-dates.js';
import { indiaTodayAsDate } from '../../common/india-date.js';
import { searchBlockers } from './aircraft-search.js';
import type { ExpiryCandidate } from '../compliance/expiry.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import {
  aircraftWhere,
  assertAdmin,
  assertCan,
  can,
  inScope,
  type Capability,
  type OperatorAccess,
} from '../operators/operator-access.js';
import {
  OperatorsService,
  type OperatorRecord,
} from '../operators/operators.service.js';
import {
  nextAircraftStatus,
  type AircraftAction,
  type MaterialField,
} from './aircraft-transitions.js';
import {
  HOME_BASE_SELECT,
  type AircraftDetail,
  type AircraftDocumentRecord,
  type AircraftMediaRecord,
  type AircraftWithHomeBase,
} from './aircraft.mappers.js';

/** Documents required before an aircraft can be submitted (D-047). */
export const REQUIRED_AIRCRAFT_DOCUMENTS: AircraftDocumentType[] = [
  AircraftDocumentType.REGISTRATION,
  AircraftDocumentType.AIRWORTHINESS,
  AircraftDocumentType.INSURANCE,
];

const MAX_AIRCRAFT_DOCUMENTS = 20;
const MAX_AIRCRAFT_MEDIA = 30;
const MAX_AIRCRAFT = 50;
const MAX_OPERATOR_FILES = 200;

/** Aircraft columns stored as JSON, compared by value on update. */
const JSON_COLUMNS = new Set<string>([
  'restrictions',
  'specifications',
  'medicalEquipment',
]);

const ROTARY: AircraftCategory[] = [
  AircraftCategory.HELICOPTER,
  AircraftCategory.AIR_AMBULANCE_ROTARY,
];

/** Internal roles that may open aircraft files. Finance has no aircraft access. */
const INTERNAL_READERS: Role[] = [Role.OPS, Role.SUPER_ADMIN];

function notFound(what = 'Aircraft'): AppException {
  return new AppException(
    'NOT_FOUND',
    `${what} not found.`,
    HttpStatus.NOT_FOUND,
  );
}

function expectedWingType(category: AircraftCategory): WingType {
  return ROTARY.includes(category) ? WingType.HELICOPTER : WingType.FIXED_WING;
}

/** Owns Aircraft, AircraftMedia and AircraftDocument. */
@Injectable()
export class AircraftService implements OnModuleInit {
  private readonly logger = new Logger(AircraftService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly operators: OperatorsService,
    private readonly documents: DocumentsService,
    private readonly locations: LocationsService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.documents.registerAccessCheck(
      FilePurpose.AIRCRAFT_PHOTO,
      (file, user) => this.mayReadAircraftFile(file.id, user),
    );
    this.documents.registerAccessCheck(
      FilePurpose.AIRCRAFT_FLOOR_PLAN,
      (file, user) => this.mayReadAircraftFile(file.id, user),
    );
    this.documents.registerAccessCheck(
      FilePurpose.AIRCRAFT_DOCUMENT,
      (file, user) => this.mayReadAircraftFile(file.id, user),
    );
    // Staff assignments name aircraft; operators asks here whether they are
    // the operator's own.
    this.operators.registerAircraftCheck(async (operatorId, ids) => {
      const rows = await this.prisma.aircraft.findMany({
        where: { operatorId, id: { in: ids } },
        select: { id: true },
      });
      const known = new Set(rows.map((row) => row.id));
      return ids.filter((id) => !known.has(id));
    });
  }

  private async mayReadAircraftFile(
    fileId: string,
    user: AuthUser,
  ): Promise<boolean> {
    if (INTERNAL_READERS.includes(user.role)) return true;
    if (
      user.role !== Role.OPERATOR_ADMIN &&
      user.role !== Role.OPERATOR_STAFF
    ) {
      return false;
    }
    // The operator's administrators, and staff on an aircraft in their reach
    // with either capability (D-049).
    const { access } = await this.operators.accessFor(user);
    if (!can(access, 'MANAGE_AIRCRAFT', 'MANAGE_AVAILABILITY')) return false;
    const aircraft = aircraftWhere(access);
    const media = await this.prisma.aircraftMedia.findFirst({
      where: { fileId, aircraft },
      select: { id: true },
    });
    if (media) return true;
    const document = await this.prisma.aircraftDocument.findFirst({
      where: { fileId, aircraft },
      select: { id: true },
    });
    return document !== null;
  }

  // --- Operator scope -----------------------------------------------------

  /**
   * The caller's operator and an aircraft in their reach that they may act
   * on with one of the capabilities. An aircraft out of reach answers 404,
   * like another operator's, so its existence is not revealed; a missing
   * capability on one in reach answers 403.
   */
  private async scoped(
    user: AuthUser,
    aircraftId: string,
    ...capabilities: Capability[]
  ): Promise<{
    operator: OperatorRecord;
    access: OperatorAccess;
    aircraft: Aircraft;
  }> {
    const { operator, access } = await this.operators.accessFor(user);
    const aircraft = await this.inReach(access, aircraftId);
    assertCan(access, ...capabilities);
    return { operator, access, aircraft };
  }

  /** An aircraft of the caller's operator within their reach, or 404. */
  async inReach(access: OperatorAccess, aircraftId: string): Promise<Aircraft> {
    if (!inScope(access, aircraftId)) throw notFound();
    const aircraft = await this.prisma.aircraft.findFirst({
      where: { id: aircraftId, operatorId: access.operatorId },
    });
    if (!aircraft) throw notFound();
    return aircraft;
  }

  /** Every aircraft within the caller's reach, with its home base, by registration. */
  async fleetFor(access: OperatorAccess): Promise<AircraftWithHomeBase[]> {
    return this.prisma.aircraft.findMany({
      where: aircraftWhere(access),
      include: { homeBase: { select: HOME_BASE_SELECT } },
      orderBy: [{ registration: 'asc' }, { id: 'asc' }],
    });
  }

  /**
   * Aircraft documents for the expiry job and page (compliance module,
   * D-072): every non-rejected copy of each type that has a copy expiring by
   * `until`, for listings that are live or under review, of live operators.
   * Reads the operator's name for display (a read-only join, as in the admin
   * list, D-066).
   */
  async expiryCandidates(until: Date): Promise<ExpiryCandidate[]> {
    const notRejected = { not: DocumentVerificationStatus.REJECTED };
    const liveAircraft = {
      listingStatus: {
        in: [
          AircraftListingStatus.APPROVED,
          AircraftListingStatus.PENDING_REVIEW,
          AircraftListingStatus.SUSPENDED,
        ],
      },
      operator: {
        status: { in: [OperatorStatus.APPROVED, OperatorStatus.SUSPENDED] },
      },
    };
    const expiring = await this.prisma.aircraftDocument.findMany({
      where: {
        expiresAt: { lte: until },
        verificationStatus: notRejected,
        aircraft: liveAircraft,
      },
      select: { aircraftId: true, type: true },
      distinct: ['aircraftId', 'type'],
    });
    if (expiring.length === 0) return [];
    const rows = await this.prisma.aircraftDocument.findMany({
      where: { verificationStatus: notRejected, OR: expiring },
      include: {
        aircraft: {
          select: {
            registration: true,
            operatorId: true,
            operator: { select: { legalName: true, tradingName: true } },
          },
        },
      },
    });
    return rows.map((row) => ({
      kind: 'AIRCRAFT',
      documentId: row.id,
      type: row.type,
      expiresAt: row.expiresAt,
      verificationStatus: row.verificationStatus,
      operatorId: row.aircraft.operatorId,
      operatorName:
        row.aircraft.operator.tradingName ?? row.aircraft.operator.legalName,
      aircraftId: row.aircraftId,
      registration: row.aircraft.registration,
    }));
  }

  /** IDs of every aircraft within the caller's reach. */
  async idsFor(access: OperatorAccess): Promise<string[]> {
    const rows = await this.prisma.aircraft.findMany({
      where: aircraftWhere(access),
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  private underReview(): AppException {
    return new AppException(
      'AIRCRAFT_UNDER_REVIEW',
      'This aircraft is under review and cannot be changed until a decision is made.',
      HttpStatus.CONFLICT,
    );
  }

  private assertEditable(aircraft: Aircraft): void {
    if (aircraft.listingStatus === AircraftListingStatus.PENDING_REVIEW) {
      throw this.underReview();
    }
    if (aircraft.listingStatus === AircraftListingStatus.SUSPENDED) {
      throw new AppException(
        'AIRCRAFT_SUSPENDED',
        'A suspended aircraft stays suspended until operations reinstate it.',
        HttpStatus.CONFLICT,
      );
    }
  }

  /** Only an approved listing returns to review after a material change. */
  private needsReReview(status: AircraftListingStatus): boolean {
    return status === AircraftListingStatus.APPROVED;
  }

  /**
   * The only place a listing status is written. The conditional update locks
   * the row, so a document removed in the same moment cannot land afterwards.
   */
  private async moveListing(
    tx: Prisma.TransactionClient,
    aircraft: Aircraft,
    action: AircraftAction,
    role: Role,
    extra: Prisma.AircraftUpdateManyMutationInput = {},
    reason?: string,
  ): Promise<void> {
    const next = nextAircraftStatus(
      action,
      aircraft.listingStatus,
      role,
      reason,
    );
    if ('refused' in next) throw this.refusal(next.refused, aircraft, action);
    // Operator-side moves open a fresh review. Review decisions (step 4) pass
    // their own reviewer, time and note through `extra` and keep them.
    const opensReview = action === 'submit' || action === 'returnToReview';
    const { count } = await tx.aircraft.updateMany({
      where: { id: aircraft.id, listingStatus: aircraft.listingStatus },
      data: {
        ...extra,
        listingStatus: next.to,
        ...(opensReview
          ? {
              submittedAt: new Date(),
              reviewedById: null,
              reviewedAt: null,
              reviewNote: null,
            }
          : {}),
      },
    });
    if (count !== 1) throw this.refusal('state', aircraft, action);
  }

  private listingSnapshot(row: Aircraft) {
    return {
      listingStatus: row.listingStatus,
      registration: row.registration,
      manufacturer: row.manufacturer,
      model: row.model,
      category: row.category,
      wingType: row.wingType,
      passengerCapacity: row.passengerCapacity,
      baggageCapacityKg: row.baggageCapacityKg,
      rangeKm: row.rangeKm,
      cruiseSpeedKmh: row.cruiseSpeedKmh,
      homeBaseId: row.homeBaseId,
      pricingModel: row.pricingModel,
      medicalEquipment: row.medicalEquipment,
    };
  }

  /**
   * Adding to the fleet (create, edit, upload, submit) is for an approved
   * operator only (D-056). Taking an aircraft out of service and removing
   * files stay open, so a suspended operator can still ground an aircraft.
   */
  private assertApprovedOperator(status: OperatorStatus): void {
    if (status !== OperatorStatus.APPROVED) {
      throw new AppException(
        'OPERATOR_NOT_APPROVED',
        'Only an approved operator can manage aircraft.',
        HttpStatus.CONFLICT,
      );
    }
  }

  /**
   * Confirms the listing is still in the status we read, so a concurrent
   * submit cannot leave a write landing after PENDING_REVIEW.
   */
  private async assertStillEditable(
    tx: Prisma.TransactionClient,
    aircraft: Aircraft,
  ): Promise<void> {
    const { count } = await tx.aircraft.updateMany({
      where: {
        id: aircraft.id,
        listingStatus: aircraft.listingStatus,
      },
      data: { listingStatus: aircraft.listingStatus },
    });
    if (count !== 1) throw this.underReview();
  }

  private assertWingMatch(
    category: AircraftCategory,
    wingType: WingType,
  ): void {
    const expected = expectedWingType(category);
    if (wingType !== expected) {
      throw new AppException(
        'VALIDATION_ERROR',
        `Category ${category} requires wingType ${expected}.`,
        HttpStatus.BAD_REQUEST,
        [{ field: 'wingType', issue: `must be ${expected} for ${category}` }],
      );
    }
  }

  private async assertActiveLocation(
    locationId: string | null | undefined,
    field: string,
  ): Promise<void> {
    if (!locationId) return;
    if (!(await this.locations.isActive(locationId))) {
      throw new AppException(
        'VALIDATION_ERROR',
        'Location not found or inactive.',
        HttpStatus.BAD_REQUEST,
        [{ field, issue: 'must be an active location' }],
      );
    }
  }

  // --- Search (M5) ---------------------------------------------------------

  /**
   * Listed, in-service aircraft of the given categories, each with what it
   * is still missing (`missing()`), for matching. The operator's status is
   * checked by the caller through OperatorsService.
   */
  async searchCandidates(filter: {
    categories: AircraftCategory[];
    minPassengers: number;
    /** Before routing factor and reserve; matching checks those. */
    minRangeKm: number;
  }): Promise<(Aircraft & { missing: string[] })[]> {
    // Every eligible aircraft is considered (no cap), so none is hidden.
    const rows = await this.prisma.aircraft.findMany({
      where: {
        category: { in: filter.categories },
        listingStatus: AircraftListingStatus.APPROVED,
        availabilityStatus: AircraftAvailabilityStatus.AVAILABLE,
        passengerCapacity: { gte: filter.minPassengers },
        rangeKm: { gte: Math.floor(filter.minRangeKm) },
      },
      orderBy: { createdAt: 'asc' },
    });
    return Promise.all(
      rows.map(async (row) => ({ ...row, missing: await this.missing(row) })),
    );
  }

  // --- Completeness -------------------------------------------------------

  async missing(
    aircraft: Aircraft,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<string[]> {
    const gaps: string[] = [];
    if (!aircraft.homeBaseId) gaps.push('homeBaseId');
    if (aircraft.rangeKm == null) gaps.push('rangeKm');
    // Today in India: a document is expired from the day after its date
    // there, as the expiry job and the web count it (D-072).
    const today = indiaTodayAsDate();
    const held = await db.aircraftDocument.findMany({
      where: {
        aircraftId: aircraft.id,
        verificationStatus: { not: DocumentVerificationStatus.REJECTED },
      },
      select: { type: true, expiresAt: true },
    });
    // A renewed document counts even while the expired one is still attached.
    for (const type of REQUIRED_AIRCRAFT_DOCUMENTS) {
      const current = held.some(
        (document) =>
          document.type === type &&
          (!document.expiresAt || document.expiresAt >= today),
      );
      if (!current) gaps.push(`document:${type}`);
    }
    return gaps;
  }

  private async withDetail(aircraft: Aircraft): Promise<AircraftDetail> {
    const [mediaRows, documentRows, missing] = await Promise.all([
      this.prisma.aircraftMedia.findMany({
        where: { aircraftId: aircraft.id },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      }),
      this.prisma.aircraftDocument.findMany({
        where: { aircraftId: aircraft.id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      this.missing(aircraft),
    ]);
    const fileIds = [
      ...mediaRows.map((row) => row.fileId),
      ...documentRows.map((row) => row.fileId),
    ];
    const [files, homeBase, operatorStatus] = await Promise.all([
      this.documents.describe(fileIds),
      aircraft.homeBaseId ? this.locations.summary(aircraft.homeBaseId) : null,
      this.operators.statusOf(aircraft.operatorId),
    ]);
    const media: AircraftMediaRecord[] = mediaRows.map((row) => ({
      ...row,
      fileName: files.get(row.fileId)?.fileName ?? 'file',
    }));
    const documents: AircraftDocumentRecord[] = documentRows.map((row) => ({
      ...row,
      fileName: files.get(row.fileId)?.fileName ?? 'document',
    }));
    return {
      ...aircraft,
      homeBase,
      media,
      documents,
      missing,
      searchBlockers: searchBlockers({
        listingStatus: aircraft.listingStatus,
        availabilityStatus: aircraft.availabilityStatus,
        operatorStatus,
        missing,
      }),
    };
  }

  // --- CRUD ---------------------------------------------------------------

  async list(
    user: AuthUser,
    query: {
      page: number;
      pageSize: number;
      listingStatus?: AircraftListingStatus;
    },
  ): Promise<Paginated<AircraftWithHomeBase>> {
    const { access } = await this.operators.accessFor(user);
    assertCan(access, 'MANAGE_AIRCRAFT', 'MANAGE_AVAILABILITY');
    const where: Prisma.AircraftWhereInput = {
      ...aircraftWhere(access),
      ...(query.listingStatus ? { listingStatus: query.listingStatus } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.aircraft.findMany({
        where,
        include: { homeBase: { select: HOME_BASE_SELECT } },
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.aircraft.count({ where }),
    ]);
    return new Paginated(items, query.page, query.pageSize, total);
  }

  async get(user: AuthUser, aircraftId: string): Promise<AircraftDetail> {
    const { aircraft } = await this.scoped(
      user,
      aircraftId,
      'MANAGE_AIRCRAFT',
      'MANAGE_AVAILABILITY',
    );
    return this.withDetail(aircraft);
  }

  async create(
    user: AuthUser,
    input: {
      registration: string;
      manufacturer: string;
      model: string;
      category: AircraftCategory;
      wingType: WingType;
      passengerCapacity: number;
      baggageCapacityKg?: number | null;
      rangeKm?: number | null;
      cruiseSpeedKmh?: number | null;
      homeBaseId?: string | null;
      currentLocationId?: string | null;
      operatingRegions?: string[];
      restrictions?: Record<string, unknown> | null;
      pricingModel?: Prisma.AircraftCreateInput['pricingModel'];
      specifications?: Record<string, unknown> | null;
      medicalEquipment?: Record<string, unknown> | null;
    },
  ): Promise<AircraftDetail> {
    const { operator, access } = await this.operators.accessFor(user);
    // Only administrators add aircraft; staff are assigned existing ones.
    assertAdmin(access);
    this.assertApprovedOperator(operator.status);
    const held = await this.prisma.aircraft.count({
      where: { operatorId: operator.id },
    });
    if (held >= MAX_AIRCRAFT) {
      throw new AppException(
        'AIRCRAFT_LIMIT_REACHED',
        `An operator can list up to ${MAX_AIRCRAFT} aircraft.`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    this.assertWingMatch(input.category, input.wingType);
    await this.assertActiveLocation(input.homeBaseId, 'homeBaseId');
    await this.assertActiveLocation(
      input.currentLocationId,
      'currentLocationId',
    );

    const registration = input.registration.trim().toUpperCase();
    const created = await uniqueOrNull(() =>
      this.prisma.$transaction(async (tx) => {
        const row = await tx.aircraft.create({
          data: {
            operatorId: operator.id,
            registration,
            manufacturer: input.manufacturer.trim(),
            model: input.model.trim(),
            category: input.category,
            wingType: input.wingType,
            passengerCapacity: input.passengerCapacity,
            baggageCapacityKg: input.baggageCapacityKg ?? null,
            rangeKm: input.rangeKm ?? null,
            cruiseSpeedKmh: input.cruiseSpeedKmh ?? null,
            homeBaseId: input.homeBaseId ?? null,
            currentLocationId: input.currentLocationId ?? null,
            operatingRegions: input.operatingRegions ?? [],
            restrictions: input.restrictions
              ? (input.restrictions as Prisma.InputJsonValue)
              : Prisma.JsonNull,
            pricingModel: input.pricingModel,
            specifications: input.specifications
              ? (input.specifications as Prisma.InputJsonValue)
              : Prisma.JsonNull,
            medicalEquipment: input.medicalEquipment
              ? (input.medicalEquipment as Prisma.InputJsonValue)
              : Prisma.JsonNull,
          },
        });
        await this.audit.record(
          {
            action: 'aircraft.create',
            entityType: 'Aircraft',
            entityId: row.id,
            after: {
              operatorId: operator.id,
              registration: row.registration,
              category: row.category,
            },
          },
          tx,
        );
        return row;
      }),
    );
    if (!created) {
      throw new AppException(
        'AIRCRAFT_REGISTRATION_IN_USE',
        'An aircraft with this registration already exists.',
        HttpStatus.CONFLICT,
        [{ field: 'registration', issue: 'already in use' }],
      );
    }
    return this.withDetail(created);
  }

  async update(
    user: AuthUser,
    aircraftId: string,
    changes: Partial<{
      registration: string;
      manufacturer: string;
      model: string;
      category: AircraftCategory;
      wingType: WingType;
      passengerCapacity: number;
      baggageCapacityKg: number | null;
      rangeKm: number | null;
      cruiseSpeedKmh: number | null;
      homeBaseId: string | null;
      currentLocationId: string | null;
      operatingRegions: string[];
      restrictions: Record<string, unknown> | null;
      pricingModel: Prisma.AircraftUpdateInput['pricingModel'];
      specifications: Record<string, unknown> | null;
      medicalEquipment: Record<string, unknown> | null;
    }>,
  ): Promise<AircraftDetail> {
    const { operator, aircraft } = await this.scoped(
      user,
      aircraftId,
      'MANAGE_AIRCRAFT',
    );
    this.assertApprovedOperator(operator.status);
    this.assertEditable(aircraft);

    const nextCategory = changes.category ?? aircraft.category;
    const nextWing = changes.wingType ?? aircraft.wingType;
    if (changes.category !== undefined || changes.wingType !== undefined) {
      this.assertWingMatch(nextCategory, nextWing);
    }
    if (changes.homeBaseId !== undefined) {
      await this.assertActiveLocation(changes.homeBaseId, 'homeBaseId');
    }
    if (changes.currentLocationId !== undefined) {
      await this.assertActiveLocation(
        changes.currentLocationId,
        'currentLocationId',
      );
    }

    const data: Prisma.AircraftUncheckedUpdateManyInput = {};
    const materialTouched: MaterialField[] = [];

    if (changes.registration !== undefined) {
      const next = changes.registration.trim().toUpperCase();
      data.registration = next;
      if (next !== aircraft.registration) materialTouched.push('registration');
    }
    if (changes.manufacturer !== undefined) {
      const next = changes.manufacturer.trim();
      data.manufacturer = next;
      if (next !== aircraft.manufacturer) materialTouched.push('manufacturer');
    }
    if (changes.model !== undefined) {
      const next = changes.model.trim();
      data.model = next;
      if (next !== aircraft.model) materialTouched.push('model');
    }
    if (changes.category !== undefined) {
      data.category = changes.category;
      if (changes.category !== aircraft.category) {
        materialTouched.push('category');
      }
    }
    if (changes.wingType !== undefined) {
      data.wingType = changes.wingType;
      if (changes.wingType !== aircraft.wingType) {
        materialTouched.push('wingType');
      }
    }
    if (changes.passengerCapacity !== undefined) {
      data.passengerCapacity = changes.passengerCapacity;
      if (changes.passengerCapacity !== aircraft.passengerCapacity) {
        materialTouched.push('passengerCapacity');
      }
    }
    if (changes.baggageCapacityKg !== undefined) {
      data.baggageCapacityKg = changes.baggageCapacityKg;
      if (changes.baggageCapacityKg !== aircraft.baggageCapacityKg) {
        materialTouched.push('baggageCapacityKg');
      }
    }
    if (changes.rangeKm !== undefined) {
      data.rangeKm = changes.rangeKm;
      if (changes.rangeKm !== aircraft.rangeKm) materialTouched.push('rangeKm');
    }
    if (changes.cruiseSpeedKmh !== undefined) {
      data.cruiseSpeedKmh = changes.cruiseSpeedKmh;
      if (changes.cruiseSpeedKmh !== aircraft.cruiseSpeedKmh) {
        materialTouched.push('cruiseSpeedKmh');
      }
    }
    if (changes.homeBaseId !== undefined) {
      data.homeBaseId = changes.homeBaseId;
      if (changes.homeBaseId !== aircraft.homeBaseId) {
        materialTouched.push('homeBaseId');
      }
    }
    if (changes.currentLocationId !== undefined) {
      data.currentLocationId = changes.currentLocationId;
    }
    if (changes.operatingRegions !== undefined) {
      data.operatingRegions = changes.operatingRegions;
    }
    if (changes.restrictions !== undefined) {
      data.restrictions =
        (changes.restrictions as Prisma.InputJsonValue | null) ??
        Prisma.JsonNull;
    }
    if (changes.pricingModel !== undefined) {
      data.pricingModel = changes.pricingModel;
      if (changes.pricingModel !== aircraft.pricingModel) {
        materialTouched.push('pricingModel');
      }
    }
    if (changes.specifications !== undefined) {
      data.specifications =
        (changes.specifications as Prisma.InputJsonValue | null) ??
        Prisma.JsonNull;
    }
    if (changes.medicalEquipment !== undefined) {
      data.medicalEquipment =
        (changes.medicalEquipment as Prisma.InputJsonValue | null) ??
        Prisma.JsonNull;
      if (!jsonEqual(changes.medicalEquipment, aircraft.medicalEquipment)) {
        materialTouched.push('medicalEquipment');
      }
    }

    // Drop values that are already stored, so an unchanged PATCH writes and
    // audits nothing (as for locations, D-054). JSON columns compare by value,
    // ignoring key order (D-066).
    const stored = aircraft as unknown as Record<string, unknown>;
    for (const key of Object.keys(data) as (keyof typeof data)[]) {
      const value = data[key];
      const same = JSON_COLUMNS.has(key)
        ? jsonEqual(value === Prisma.JsonNull ? null : value, stored[key])
        : Array.isArray(value)
          ? JSON.stringify(value) === JSON.stringify(stored[key])
          : (value === null || typeof value !== 'object') &&
            value === stored[key];
      if (same) delete data[key];
    }
    if (Object.keys(data).length === 0) return this.withDetail(aircraft);

    // materialTouched records real value changes only, so an unchanged
    // material field never re-queues review.
    const revertToReview =
      materialTouched.length > 0 && this.needsReReview(aircraft.listingStatus);

    const updated = await uniqueOrNull(() =>
      this.prisma.$transaction(async (tx) => {
        if (revertToReview) {
          await this.moveListing(
            tx,
            aircraft,
            'returnToReview',
            user.role,
            data,
          );
        } else {
          const { count } = await tx.aircraft.updateMany({
            where: {
              id: aircraft.id,
              listingStatus: aircraft.listingStatus,
            },
            data,
          });
          if (count !== 1) throw this.underReview();
        }
        const row = await tx.aircraft.findUniqueOrThrow({
          where: { id: aircraft.id },
        });
        await this.audit.record(
          {
            action: revertToReview
              ? 'aircraft.material_edit'
              : 'aircraft.update',
            entityType: 'Aircraft',
            entityId: row.id,
            before: {
              ...this.listingSnapshot(aircraft),
              fields: materialTouched,
            },
            after: {
              ...this.listingSnapshot(row),
              fields: materialTouched,
              revertedToReview: revertToReview,
            },
          },
          tx,
        );
        return row;
      }),
    );
    if (!updated) {
      throw new AppException(
        'AIRCRAFT_REGISTRATION_IN_USE',
        'An aircraft with this registration already exists.',
        HttpStatus.CONFLICT,
        [{ field: 'registration', issue: 'already in use' }],
      );
    }
    return this.withDetail(updated);
  }

  async setAvailabilityStatus(
    user: AuthUser,
    aircraftId: string,
    status: AircraftAvailabilityStatus,
  ): Promise<AircraftDetail> {
    // Grounding is a safety action: either capability may do it.
    const { aircraft } = await this.scoped(
      user,
      aircraftId,
      'MANAGE_AIRCRAFT',
      'MANAGE_AVAILABILITY',
    );
    // Availability may change while a listing is under review, and for an
    // operator who is not approved (search also requires an approved one).
    // It does not change a suspended listing's status.
    const updated = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.aircraft.updateMany({
        where: { id: aircraft.id },
        data: { availabilityStatus: status },
      });
      if (count !== 1) throw notFound();
      const row = await tx.aircraft.findUniqueOrThrow({
        where: { id: aircraft.id },
      });
      await this.audit.record(
        {
          action: 'aircraft.availability_status',
          entityType: 'Aircraft',
          entityId: row.id,
          before: { availabilityStatus: aircraft.availabilityStatus },
          after: { availabilityStatus: row.availabilityStatus },
        },
        tx,
      );
      return row;
    });
    return this.withDetail(updated);
  }

  async submit(user: AuthUser, aircraftId: string): Promise<AircraftDetail> {
    const { operator, aircraft } = await this.scoped(
      user,
      aircraftId,
      'MANAGE_AIRCRAFT',
    );
    this.assertApprovedOperator(operator.status);
    const next = nextAircraftStatus(
      'submit',
      aircraft.listingStatus,
      user.role,
    );
    if ('refused' in next) {
      throw this.refusal(next.refused, aircraft, 'submit');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      // Lock the row by taking the status first. The document check then
      // sees a stable set, and a failure rolls the status change back.
      await this.moveListing(tx, aircraft, 'submit', user.role);
      // Check the row as it is now locked, not as it was read before.
      const current = await tx.aircraft.findUniqueOrThrow({
        where: { id: aircraft.id },
      });
      const gaps = await this.missing(current, tx);
      if (gaps.length > 0) {
        throw new AppException(
          'AIRCRAFT_PROFILE_INCOMPLETE',
          'Complete the aircraft profile before submitting it. Required documents must be present and unexpired.',
          HttpStatus.UNPROCESSABLE_ENTITY,
          gaps.map((field) => ({ field, issue: 'is required' })),
        );
      }
      const row = await tx.aircraft.findUniqueOrThrow({
        where: { id: aircraft.id },
      });
      await this.audit.record(
        {
          action: 'aircraft.submit',
          entityType: 'Aircraft',
          entityId: row.id,
          before: { listingStatus: aircraft.listingStatus },
          after: { listingStatus: row.listingStatus },
        },
        tx,
      );
      return row;
    });
    return this.withDetail(updated);
  }

  // --- Media --------------------------------------------------------------

  async addMedia(
    user: AuthUser,
    aircraftId: string,
    input: {
      fileId: string;
      kind: AircraftMediaKind;
      sortOrder?: number;
    },
  ): Promise<AircraftMediaRecord> {
    const { operator, aircraft } = await this.scoped(
      user,
      aircraftId,
      'MANAGE_AIRCRAFT',
    );
    this.assertApprovedOperator(operator.status);
    this.assertEditable(aircraft);
    await this.assertFileRoom(operator.id);
    const held = await this.prisma.aircraftMedia.count({
      where: { aircraftId: aircraft.id },
    });
    if (held >= MAX_AIRCRAFT_MEDIA) {
      throw new AppException(
        'AIRCRAFT_MEDIA_LIMIT_REACHED',
        `An aircraft can hold up to ${MAX_AIRCRAFT_MEDIA} photos.`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    const purpose =
      input.kind === AircraftMediaKind.FLOOR_PLAN
        ? FilePurpose.AIRCRAFT_FLOOR_PLAN
        : FilePurpose.AIRCRAFT_PHOTO;

    return this.prisma.$transaction(async (tx) => {
      await this.assertStillEditable(tx, aircraft);
      const file = await this.documents.claim(
        input.fileId,
        user.id,
        purpose,
        tx,
      );
      if (!file.contentType.startsWith('image/')) {
        throw new AppException(
          'VALIDATION_ERROR',
          'A photo or floor plan must be a JPEG or PNG.',
          HttpStatus.BAD_REQUEST,
          [{ field: 'fileId', issue: 'must be an image' }],
        );
      }
      const row = await tx.aircraftMedia.create({
        data: {
          aircraftId: aircraft.id,
          fileId: file.id,
          kind: input.kind,
          sortOrder: input.sortOrder ?? held,
        },
      });
      await this.audit.record(
        {
          action: 'aircraft_media.add',
          entityType: 'AircraftMedia',
          entityId: row.id,
          after: { aircraftId: aircraft.id, kind: row.kind },
        },
        tx,
      );
      return { ...row, fileName: file.fileName };
    });
  }

  async removeMedia(
    user: AuthUser,
    aircraftId: string,
    mediaId: string,
  ): Promise<void> {
    const { aircraft } = await this.scoped(user, aircraftId, 'MANAGE_AIRCRAFT');
    this.assertEditable(aircraft);
    const media = await this.prisma.aircraftMedia.findFirst({
      where: { id: mediaId, aircraftId: aircraft.id },
    });
    if (!media) throw notFound('Media');
    await this.prisma.$transaction(async (tx) => {
      await this.assertStillEditable(tx, aircraft);
      await tx.aircraftMedia.delete({ where: { id: media.id } });
      await this.audit.record(
        {
          action: 'aircraft_media.remove',
          entityType: 'AircraftMedia',
          entityId: media.id,
          before: { aircraftId: aircraft.id, kind: media.kind },
        },
        tx,
      );
    });
    await this.documents.remove(media.fileId).catch((error: unknown) => {
      this.logger.error(
        `Could not remove the stored file of deleted media: ${
          error instanceof Error ? error.name : 'unknown error'
        }`,
      );
    });
  }

  // --- Documents ----------------------------------------------------------

  async addDocument(
    user: AuthUser,
    aircraftId: string,
    input: {
      type: AircraftDocumentType;
      fileId: string;
      issuedAt?: string | null;
      expiresAt?: string | null;
    },
  ): Promise<AircraftDocumentRecord> {
    const { operator, aircraft } = await this.scoped(
      user,
      aircraftId,
      'MANAGE_AIRCRAFT',
    );
    this.assertApprovedOperator(operator.status);
    this.assertEditable(aircraft);
    await this.assertFileRoom(operator.id);
    const held = await this.prisma.aircraftDocument.count({
      where: { aircraftId: aircraft.id },
    });
    if (held >= MAX_AIRCRAFT_DOCUMENTS) {
      throw new AppException(
        'AIRCRAFT_DOCUMENT_LIMIT_REACHED',
        `An aircraft can hold up to ${MAX_AIRCRAFT_DOCUMENTS} documents.`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    assertDocumentDates(input.issuedAt, input.expiresAt);
    const revertToReview = this.needsReReview(aircraft.listingStatus);

    return this.prisma.$transaction(async (tx) => {
      if (revertToReview) {
        await this.moveListing(tx, aircraft, 'returnToReview', user.role);
      } else {
        await this.assertStillEditable(tx, aircraft);
      }

      const file = await this.documents.claim(
        input.fileId,
        user.id,
        FilePurpose.AIRCRAFT_DOCUMENT,
        tx,
      );
      const row = await tx.aircraftDocument.create({
        data: {
          aircraftId: aircraft.id,
          type: input.type,
          fileId: file.id,
          issuedAt: input.issuedAt ? new Date(input.issuedAt) : null,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        },
      });
      await this.audit.record(
        {
          action: 'aircraft_document.add',
          entityType: 'AircraftDocument',
          entityId: row.id,
          after: {
            aircraftId: aircraft.id,
            type: row.type,
            revertedToReview: revertToReview,
          },
        },
        tx,
      );
      return { ...row, fileName: file.fileName };
    });
  }

  async removeDocument(
    user: AuthUser,
    aircraftId: string,
    documentId: string,
  ): Promise<void> {
    const { aircraft } = await this.scoped(user, aircraftId, 'MANAGE_AIRCRAFT');
    this.assertEditable(aircraft);
    const document = await this.prisma.aircraftDocument.findFirst({
      where: { id: documentId, aircraftId: aircraft.id },
    });
    if (!document) throw notFound('Document');
    if (
      document.verificationStatus === DocumentVerificationStatus.VERIFIED &&
      aircraft.listingStatus !== AircraftListingStatus.DRAFT &&
      aircraft.listingStatus !== AircraftListingStatus.REJECTED
    ) {
      throw new AppException(
        'AIRCRAFT_DOCUMENT_LOCKED',
        'A verified document cannot be removed. Upload its replacement instead.',
        HttpStatus.CONFLICT,
      );
    }

    const revertToReview = this.needsReReview(aircraft.listingStatus);

    await this.prisma.$transaction(async (tx) => {
      if (revertToReview) {
        await this.moveListing(tx, aircraft, 'returnToReview', user.role);
      } else {
        await this.assertStillEditable(tx, aircraft);
      }
      await tx.aircraftDocument.delete({ where: { id: document.id } });
      await this.audit.record(
        {
          action: 'aircraft_document.remove',
          entityType: 'AircraftDocument',
          entityId: document.id,
          before: {
            aircraftId: aircraft.id,
            type: document.type,
            revertedToReview: revertToReview,
          },
        },
        tx,
      );
    });
    await this.documents.remove(document.fileId).catch((error: unknown) => {
      this.logger.error(
        `Could not remove the stored file of a deleted document: ${
          error instanceof Error ? error.name : 'unknown error'
        }`,
      );
    });
  }

  private async assertFileRoom(operatorId: string): Promise<void> {
    const [media, documents] = await this.prisma.$transaction([
      this.prisma.aircraftMedia.count({
        where: { aircraft: { operatorId } },
      }),
      this.prisma.aircraftDocument.count({
        where: { aircraft: { operatorId } },
      }),
    ]);
    if (media + documents >= MAX_OPERATOR_FILES) {
      throw new AppException(
        'AIRCRAFT_FILE_LIMIT_REACHED',
        `An operator can attach up to ${MAX_OPERATOR_FILES} aircraft files.`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
  }

  // --- Administration -----------------------------------------------------

  async adminList(query: {
    page: number;
    pageSize: number;
    listingStatus?: AircraftListingStatus;
    operatorId?: string;
  }): Promise<Paginated<AircraftWithHomeBase & { operatorName: string }>> {
    const where: Prisma.AircraftWhereInput = {
      ...(query.listingStatus ? { listingStatus: query.listingStatus } : {}),
      ...(query.operatorId ? { operatorId: query.operatorId } : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.aircraft.findMany({
        where,
        include: {
          operator: { select: { legalName: true } },
          homeBase: { select: HOME_BASE_SELECT },
        },
        orderBy: [
          { submittedAt: { sort: 'asc', nulls: 'last' } },
          { updatedAt: 'desc' },
          { id: 'asc' },
        ],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.aircraft.count({ where }),
    ]);
    return new Paginated(
      rows.map((row) => ({ ...row, operatorName: row.operator.legalName })),
      query.page,
      query.pageSize,
      total,
    );
  }

  async adminGet(
    id: string,
  ): Promise<AircraftDetail & { operatorName: string }> {
    const aircraft = await this.prisma.aircraft.findUnique({
      where: { id },
      include: { operator: { select: { legalName: true } } },
    });
    if (!aircraft) throw notFound();
    const { operator, ...row } = aircraft;
    const detail = await this.withDetail(row);
    return { ...detail, operatorName: operator.legalName };
  }

  async review(
    actor: AuthUser,
    aircraftId: string,
    action: 'approve' | 'reject' | 'suspend' | 'reinstate',
    reason?: string,
  ): Promise<AircraftDetail> {
    const aircraft = await this.prisma.aircraft.findUnique({
      where: { id: aircraftId },
    });
    if (!aircraft) throw notFound();
    const next = nextAircraftStatus(
      action,
      aircraft.listingStatus,
      actor.role,
      reason,
    );
    if ('refused' in next) throw this.refusal(next.refused, aircraft, action);

    const updated = await this.prisma.$transaction(async (tx) => {
      await this.moveListing(
        tx,
        aircraft,
        action,
        actor.role,
        {
          reviewedById: actor.id,
          reviewedAt: new Date(),
          reviewNote: reason?.trim() || null,
        },
        reason,
      );
      // Only an approved operator's aircraft can be put (back) on sale.
      if (action === 'approve' || action === 'reinstate') {
        const status = await this.operators.statusOf(aircraft.operatorId, tx);
        if (status !== OperatorStatus.APPROVED) {
          throw new AppException(
            'OPERATOR_NOT_APPROVED',
            'The operator is not approved, so its aircraft cannot be approved or reinstated.',
            HttpStatus.CONFLICT,
          );
        }
      }
      if (action === 'approve') {
        const gaps = await this.approvalGaps(tx, aircraft.id);
        if (gaps.length > 0) {
          throw new AppException(
            'AIRCRAFT_DOCUMENTS_UNVERIFIED',
            'Verify the required documents, and check they have not expired, before approving this aircraft.',
            HttpStatus.UNPROCESSABLE_ENTITY,
            gaps.map((field) => ({ field, issue: 'is not verified' })),
          );
        }
      }
      const row = await tx.aircraft.findUniqueOrThrow({
        where: { id: aircraft.id },
      });
      await this.audit.record(
        {
          action: `aircraft.${action}`,
          entityType: 'Aircraft',
          entityId: row.id,
          before: { listingStatus: aircraft.listingStatus },
          after: { listingStatus: row.listingStatus },
          reason: reason?.trim() || undefined,
        },
        tx,
      );
      return row;
    });
    await this.notifyOperator(updated, action, reason);
    return this.withDetail(updated);
  }

  async verifyAircraftDocument(
    actor: AuthUser,
    documentId: string,
    decision: DocumentVerificationStatus,
    reason?: string,
  ): Promise<AircraftDocumentRecord> {
    if (decision === DocumentVerificationStatus.REJECTED && !reason?.trim()) {
      throw new AppException(
        'VALIDATION_ERROR',
        'A reason is required.',
        HttpStatus.BAD_REQUEST,
        [{ field: 'reason', issue: 'is required' }],
      );
    }
    let suspended: Aircraft | null = null;
    const row = await this.prisma.$transaction(async (tx) => {
      const document = await tx.aircraftDocument.findUnique({
        where: { id: documentId },
      });
      if (!document) throw notFound('Document');
      // Lock the aircraft first, so an approval in flight waits for this
      // decision instead of reading the document as still verified.
      await tx.$queryRaw`SELECT id FROM "Aircraft" WHERE id = ${document.aircraftId}::uuid FOR UPDATE`;
      const aircraft = await tx.aircraft.findUniqueOrThrow({
        where: { id: document.aircraftId },
      });
      const updated = await tx.aircraftDocument.update({
        where: { id: documentId },
        data: {
          verificationStatus: decision,
          verifiedById: actor.id,
          verifiedAt: new Date(),
          verificationNote: reason?.trim() || null,
        },
      });
      await this.audit.record(
        {
          action:
            decision === DocumentVerificationStatus.VERIFIED
              ? 'aircraft_document.verify'
              : 'aircraft_document.reject',
          entityType: 'AircraftDocument',
          entityId: documentId,
          before: { verificationStatus: document.verificationStatus },
          after: { verificationStatus: decision },
          reason: reason?.trim() || undefined,
        },
        tx,
      );
      // An approved aircraft must not stay on sale without a valid required
      // document (rule 4): rejecting the last one suspends the listing.
      if (
        decision === DocumentVerificationStatus.REJECTED &&
        aircraft.listingStatus === AircraftListingStatus.APPROVED &&
        REQUIRED_AIRCRAFT_DOCUMENTS.includes(document.type)
      ) {
        const gaps = await this.approvalGaps(tx, aircraft.id);
        if (gaps.length > 0) {
          const note = `Required document rejected: ${reason?.trim() ?? ''}`;
          await this.moveListing(
            tx,
            aircraft,
            'suspend',
            actor.role,
            {
              reviewedById: actor.id,
              reviewedAt: new Date(),
              reviewNote: note,
            },
            note,
          );
          suspended = await tx.aircraft.findUniqueOrThrow({
            where: { id: aircraft.id },
          });
          await this.audit.record(
            {
              action: 'aircraft.suspend',
              entityType: 'Aircraft',
              entityId: aircraft.id,
              before: { listingStatus: aircraft.listingStatus },
              after: { listingStatus: suspended.listingStatus },
              reason: note,
            },
            tx,
          );
        }
      }
      return updated;
    });
    if (suspended) {
      await this.notifyOperator(
        suspended,
        'suspend',
        `A required document was rejected: ${reason?.trim() ?? ''}`,
      );
    }
    const files = await this.documents.describe([row.fileId]);
    return { ...row, fileName: files.get(row.fileId)?.fileName ?? 'document' };
  }

  /** Frees a registration mark that was claimed in error. Draft or rejected only. */
  async releaseRegistration(
    actor: AuthUser,
    aircraftId: string,
    reason: string,
  ): Promise<void> {
    const aircraft = await this.prisma.aircraft.findUnique({
      where: { id: aircraftId },
    });
    if (!aircraft) throw notFound();
    if (
      aircraft.listingStatus !== AircraftListingStatus.DRAFT &&
      aircraft.listingStatus !== AircraftListingStatus.REJECTED
    ) {
      throw new AppException(
        'AIRCRAFT_REGISTRATION_LOCKED',
        'Only a draft or rejected aircraft can have its registration released. Reject or leave it in draft first.',
        HttpStatus.CONFLICT,
      );
    }
    const files = await this.prisma.$transaction(async (tx) => {
      // Lock first, so an upload committing now is either listed here or
      // refused afterwards, never left behind without its aircraft.
      await tx.$queryRaw`SELECT id FROM "Aircraft" WHERE id = ${aircraft.id}::uuid FOR UPDATE`;
      const attached = await tx.aircraft.findUnique({
        where: { id: aircraft.id },
        include: { media: true, documents: true },
      });
      // Conditional on the status, so a submit in the same moment wins.
      const { count } = await tx.aircraft.deleteMany({
        where: {
          id: aircraft.id,
          listingStatus: {
            in: [AircraftListingStatus.DRAFT, AircraftListingStatus.REJECTED],
          },
        },
      });
      if (count !== 1) {
        throw new AppException(
          'AIRCRAFT_REGISTRATION_LOCKED',
          'Only a draft or rejected aircraft can have its registration released.',
          HttpStatus.CONFLICT,
        );
      }
      await this.audit.record(
        {
          action: 'aircraft.release_registration',
          entityType: 'Aircraft',
          entityId: aircraft.id,
          before: {
            registration: aircraft.registration,
            listingStatus: aircraft.listingStatus,
            operatorId: aircraft.operatorId,
          },
          reason: reason.trim(),
        },
        tx,
      );
      return attached;
    });
    const fileIds = [
      ...(files?.media.map((row) => row.fileId) ?? []),
      ...(files?.documents.map((row) => row.fileId) ?? []),
    ];
    await Promise.all(
      fileIds.map((fileId) =>
        this.documents.remove(fileId).catch((error: unknown) => {
          this.logger.error(
            `Could not remove a file after releasing a registration: ${
              error instanceof Error ? error.name : 'unknown error'
            }`,
          );
        }),
      ),
    );
  }

  private async approvalGaps(
    tx: Prisma.TransactionClient,
    aircraftId: string,
  ): Promise<string[]> {
    // Today in India: a document is expired from the day after its date
    // there, as the expiry job and the web count it (D-072).
    const today = indiaTodayAsDate();
    const held = await tx.aircraftDocument.findMany({
      where: {
        aircraftId,
        verificationStatus: DocumentVerificationStatus.VERIFIED,
      },
      select: { type: true, expiresAt: true },
    });
    const gaps: string[] = [];
    for (const type of REQUIRED_AIRCRAFT_DOCUMENTS) {
      const current = held.some(
        (document) =>
          document.type === type &&
          (!document.expiresAt || document.expiresAt >= today),
      );
      if (!current) gaps.push(`document:${type}`);
    }
    return gaps;
  }

  private async notifyOperator(
    aircraft: Aircraft,
    action: 'approve' | 'reject' | 'suspend' | 'reinstate',
    reason?: string,
  ): Promise<void> {
    const administrators = await this.operators.administrators(
      aircraft.operatorId,
    );
    const templateKey = `aircraft.${action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : action === 'suspend' ? 'suspended' : 'reinstated'}`;
    const variables = {
      registration: aircraft.registration,
      reason: reason?.trim() ?? '',
    };
    for (const user of administrators) {
      await this.notifications.send({
        userId: user.id,
        channel: 'IN_APP',
        templateKey,
        variables,
      });
      if (user.email) {
        await this.notifications.send({
          userId: user.id,
          channel: 'EMAIL',
          templateKey,
          to: user.email,
          variables,
        });
      }
    }
  }

  private refusal(
    kind: 'role' | 'state' | 'reason',
    aircraft: Aircraft,
    action: AircraftAction,
  ): AppException {
    if (kind === 'role') {
      return new AppException(
        'FORBIDDEN',
        'You cannot perform this action.',
        HttpStatus.FORBIDDEN,
      );
    }
    if (kind === 'reason') {
      return new AppException(
        'VALIDATION_ERROR',
        'A reason is required.',
        HttpStatus.BAD_REQUEST,
        [{ field: 'reason', issue: 'is required' }],
      );
    }
    return new AppException(
      'AIRCRAFT_INVALID_TRANSITION',
      `Cannot ${action} an aircraft that is ${aircraft.listingStatus}.`,
      HttpStatus.CONFLICT,
    );
  }
}

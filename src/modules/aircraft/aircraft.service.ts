import { HttpStatus, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Paginated } from '../../common/dto/paginated.js';
import { AppException } from '../../common/errors/app.exception.js';
import { uniqueOrNull } from '../../common/errors/unique.js';
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
import { OperatorsService } from '../operators/operators.service.js';
import {
  nextAircraftStatus,
  type AircraftAction,
  type MaterialField,
} from './aircraft-transitions.js';
import type {
  AircraftDetail,
  AircraftDocumentRecord,
  AircraftMediaRecord,
} from './aircraft.mappers.js';

/** Documents required before an aircraft can be submitted (D-047). */
export const REQUIRED_AIRCRAFT_DOCUMENTS: AircraftDocumentType[] = [
  AircraftDocumentType.REGISTRATION,
  AircraftDocumentType.AIRWORTHINESS,
  AircraftDocumentType.INSURANCE,
];

const MAX_AIRCRAFT_DOCUMENTS = 20;
const MAX_AIRCRAFT_MEDIA = 30;

const ROTARY: AircraftCategory[] = [
  AircraftCategory.HELICOPTER,
  AircraftCategory.AIR_AMBULANCE_ROTARY,
];

const INTERNAL_READERS: Role[] = [
  Role.OPS,
  Role.FINANCE_ADMIN,
  Role.SUPER_ADMIN,
];

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
    const media = await this.prisma.aircraftMedia.findFirst({
      where: {
        fileId,
        aircraft: { operator: { members: { some: { userId: user.id } } } },
      },
      select: { id: true },
    });
    if (media) return true;
    const document = await this.prisma.aircraftDocument.findFirst({
      where: {
        fileId,
        aircraft: { operator: { members: { some: { userId: user.id } } } },
      },
      select: { id: true },
    });
    return document !== null;
  }

  // --- Operator scope -----------------------------------------------------

  private async forOperatorMember(userId: string) {
    return this.operators.forMember(userId);
  }

  private async loadOwned(
    operatorId: string,
    aircraftId: string,
  ): Promise<Aircraft> {
    const aircraft = await this.prisma.aircraft.findFirst({
      where: { id: aircraftId, operatorId },
    });
    if (!aircraft) throw notFound();
    return aircraft;
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
  }

  /** Approved and suspended listings both need re-review after a material change. */
  private needsReReview(status: AircraftListingStatus): boolean {
    return (
      status === AircraftListingStatus.APPROVED ||
      status === AircraftListingStatus.SUSPENDED
    );
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
    const location = await this.prisma.location.findFirst({
      where: { id: locationId, isActive: true },
      select: { id: true },
    });
    if (!location) {
      throw new AppException(
        'VALIDATION_ERROR',
        'Location not found or inactive.',
        HttpStatus.BAD_REQUEST,
        [{ field, issue: 'must be an active location' }],
      );
    }
  }

  // --- Completeness -------------------------------------------------------

  async missing(aircraft: Aircraft): Promise<string[]> {
    const gaps: string[] = [];
    if (!aircraft.homeBaseId) gaps.push('homeBaseId');
    if (aircraft.rangeKm == null) gaps.push('rangeKm');
    const held = await this.prisma.aircraftDocument.findMany({
      where: {
        aircraftId: aircraft.id,
        verificationStatus: { not: DocumentVerificationStatus.REJECTED },
      },
      select: { type: true },
    });
    for (const type of REQUIRED_AIRCRAFT_DOCUMENTS) {
      if (!held.some((document) => document.type === type)) {
        gaps.push(`document:${type}`);
      }
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
    const files = await this.documents.describe(fileIds);
    const media: AircraftMediaRecord[] = mediaRows.map((row) => ({
      ...row,
      fileName: files.get(row.fileId)?.fileName ?? 'file',
    }));
    const documents: AircraftDocumentRecord[] = documentRows.map((row) => ({
      ...row,
      fileName: files.get(row.fileId)?.fileName ?? 'document',
    }));
    return { ...aircraft, media, documents, missing };
  }

  // --- CRUD ---------------------------------------------------------------

  async list(
    userId: string,
    query: {
      page: number;
      pageSize: number;
      listingStatus?: AircraftListingStatus;
    },
  ): Promise<Paginated<Aircraft>> {
    const operator = await this.forOperatorMember(userId);
    const where: Prisma.AircraftWhereInput = {
      operatorId: operator.id,
      ...(query.listingStatus ? { listingStatus: query.listingStatus } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.aircraft.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.aircraft.count({ where }),
    ]);
    return new Paginated(items, query.page, query.pageSize, total);
  }

  async get(userId: string, aircraftId: string): Promise<AircraftDetail> {
    const operator = await this.forOperatorMember(userId);
    const aircraft = await this.loadOwned(operator.id, aircraftId);
    return this.withDetail(aircraft);
  }

  async create(
    userId: string,
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
    const operator = await this.forOperatorMember(userId);
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
    userId: string,
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
    const operator = await this.forOperatorMember(userId);
    const aircraft = await this.loadOwned(operator.id, aircraftId);
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
      materialTouched.push('medicalEquipment');
    }

    // materialTouched records real value changes; medicalEquipment counts when
    // sent (JSON equality is not compared). Unchanged material fields do not
    // re-queue review.
    const revertToReview =
      materialTouched.length > 0 && this.needsReReview(aircraft.listingStatus);

    if (revertToReview) {
      data.listingStatus = AircraftListingStatus.PENDING_REVIEW;
      data.submittedAt = new Date();
      data.reviewedById = null;
      data.reviewedAt = null;
      data.reviewNote = null;
    }

    const updated = await uniqueOrNull(() =>
      this.prisma.$transaction(async (tx) => {
        // Conditional on the status just read: a concurrent submit must win.
        const { count } = await tx.aircraft.updateMany({
          where: {
            id: aircraft.id,
            listingStatus: aircraft.listingStatus,
          },
          data,
        });
        if (count !== 1) throw this.underReview();
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
              listingStatus: aircraft.listingStatus,
              registration: aircraft.registration,
            },
            after: {
              listingStatus: row.listingStatus,
              registration: row.registration,
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
    userId: string,
    aircraftId: string,
    status: AircraftAvailabilityStatus,
  ): Promise<AircraftDetail> {
    const operator = await this.forOperatorMember(userId);
    const aircraft = await this.loadOwned(operator.id, aircraftId);
    // Availability may change while a listing is under review (D-055).
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
    const operator = await this.forOperatorMember(user.id);
    if (operator.status !== OperatorStatus.APPROVED) {
      throw new AppException(
        'OPERATOR_NOT_APPROVED',
        'Only an approved operator can submit an aircraft for review.',
        HttpStatus.CONFLICT,
      );
    }
    const aircraft = await this.loadOwned(operator.id, aircraftId);
    const next = nextAircraftStatus(
      'submit',
      aircraft.listingStatus,
      user.role,
    );
    if ('refused' in next) {
      throw this.refusal(next.refused, aircraft, 'submit');
    }
    const gaps = await this.missing(aircraft);
    if (gaps.length > 0) {
      throw new AppException(
        'AIRCRAFT_PROFILE_INCOMPLETE',
        'Complete the aircraft profile before submitting it.',
        HttpStatus.UNPROCESSABLE_ENTITY,
        gaps.map((field) => ({ field, issue: 'is required' })),
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.aircraft.updateMany({
        where: { id: aircraft.id, listingStatus: aircraft.listingStatus },
        data: {
          listingStatus: next.to,
          submittedAt: new Date(),
          reviewedById: null,
          reviewedAt: null,
          reviewNote: null,
        },
      });
      if (count !== 1) throw this.refusal('state', aircraft, 'submit');
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
    userId: string,
    aircraftId: string,
    input: {
      fileId: string;
      kind: AircraftMediaKind;
      sortOrder?: number;
    },
  ): Promise<AircraftMediaRecord> {
    const operator = await this.forOperatorMember(userId);
    const aircraft = await this.loadOwned(operator.id, aircraftId);
    this.assertEditable(aircraft);
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
        userId,
        purpose,
        tx,
      );
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
    userId: string,
    aircraftId: string,
    mediaId: string,
  ): Promise<void> {
    const operator = await this.forOperatorMember(userId);
    const aircraft = await this.loadOwned(operator.id, aircraftId);
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
    userId: string,
    aircraftId: string,
    input: {
      type: AircraftDocumentType;
      fileId: string;
      issuedAt?: string | null;
      expiresAt?: string | null;
    },
  ): Promise<AircraftDocumentRecord> {
    const operator = await this.forOperatorMember(userId);
    const aircraft = await this.loadOwned(operator.id, aircraftId);
    this.assertEditable(aircraft);
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

    const revertToReview = this.needsReReview(aircraft.listingStatus);

    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.aircraft.updateMany({
        where: {
          id: aircraft.id,
          listingStatus: aircraft.listingStatus,
        },
        data: revertToReview
          ? {
              listingStatus: AircraftListingStatus.PENDING_REVIEW,
              submittedAt: new Date(),
              reviewedById: null,
              reviewedAt: null,
              reviewNote: null,
            }
          : { listingStatus: aircraft.listingStatus },
      });
      if (count !== 1) throw this.underReview();

      const file = await this.documents.claim(
        input.fileId,
        userId,
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
    userId: string,
    aircraftId: string,
    documentId: string,
  ): Promise<void> {
    const operator = await this.forOperatorMember(userId);
    const aircraft = await this.loadOwned(operator.id, aircraftId);
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
      const { count } = await tx.aircraft.updateMany({
        where: {
          id: aircraft.id,
          listingStatus: aircraft.listingStatus,
        },
        data: revertToReview
          ? {
              listingStatus: AircraftListingStatus.PENDING_REVIEW,
              submittedAt: new Date(),
              reviewedById: null,
              reviewedAt: null,
              reviewNote: null,
            }
          : { listingStatus: aircraft.listingStatus },
      });
      if (count !== 1) throw this.underReview();
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

import { HttpStatus, Injectable, type OnModuleInit } from '@nestjs/common';
import { FieldCipher, isEncrypted } from '../../common/crypto/field-cipher.js';
import { AppException } from '../../common/errors/app.exception.js';
import {
  type IdempotencyClaim,
  markIdempotencyCommitted,
} from '../../common/idempotency/idempotency.store.js';
import { airAmbulanceReference } from '../../common/reference.js';
import type {
  AirAmbulanceMedical,
  AirAmbulanceRequest,
} from '../../generated/prisma/client.js';
import {
  AirAmbulanceStatus,
  FilePurpose,
  OperatorStatus,
  type PatientMobility,
  Role,
} from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AircraftService } from '../aircraft/aircraft.service.js';
import { AuditService } from '../audit/audit.service.js';
import { DocumentsService } from '../documents/documents.service.js';
import { LocationsService } from '../locations/locations.service.js';
import { NotificationEventsService } from '../notifications/events/notification-events.service.js';
import { OperatorsService } from '../operators/operators.service.js';
import { UsersService } from '../users/users.service.js';
import { CLOSED } from './air-ambulance-transitions.js';

/** The signed-in caller, from the session (never from the request body). */
export interface AirAmbulanceActor {
  id: string;
  role: Role;
}

export interface MedicalDetailsInput {
  patientCondition: string;
  mobility: PatientMobility;
  stretcherRequired: boolean;
  oxygenRequired: boolean;
  medicalStaffRequired?: string;
  equipmentRequired?: string;
  specialisedCare?: string;
  notes?: string;
}

/** Validated by the route's DTO (W4-4). */
export interface CreateAirAmbulanceRequestInput {
  contactName: string;
  contactPhone: string;
  contactEmail?: string;
  emergencyContactName?: string;
  emergencyContactPhone?: string;
  originLocationId: string;
  destinationLocationId: string;
  pickupAddress?: string;
  destinationFacility?: string;
  preferredAt: Date;
  patientCount: number;
  accompanyingPersons: number;
  medical: MedicalDetailsInput;
}

export interface AirAmbulanceRequestView {
  id: string;
  reference: string;
  status: AirAmbulanceStatus;
  contactName: string;
  contactPhone: string;
  contactEmail: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  originLocationId: string;
  destinationLocationId: string;
  /** Null unless the caller may read the medical details (encrypted). */
  pickupAddress: string | null;
  /** Null unless the caller may read the medical details (encrypted). */
  destinationFacility: string | null;
  preferredAt: Date;
  patientCount: number;
  accompanyingPersons: number;
  assignedToId: string | null;
  selectedOperatorId: string | null;
  /** The quotation, null until operations send one (priceType QUOTE). */
  quote: {
    amountMinor: number;
    currency: string;
    conditions: string | null;
    quotedAt: Date;
  } | null;
  confirmedAt: Date | null;
  completedAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Decrypted. Only for the readers `mayReadMedical` allows. */
export interface MedicalDetailsView {
  patientCondition: string;
  mobility: PatientMobility;
  stretcherRequired: boolean;
  oxygenRequired: boolean;
  medicalStaffRequired: string | null;
  equipmentRequired: string | null;
  specialisedCare: string | null;
  notes: string | null;
  /** StoredFile ids of the attached medical documents. */
  documentFileIds: string[];
}

export interface AirAmbulanceRequestDetail extends AirAmbulanceRequestView {
  /** Null when the caller may see the request but not the medical details. */
  medical: MedicalDetailsView | null;
}

/** From the customer's acceptance onwards (state-machines.md). */
const ACCEPTED_OR_LATER: ReadonlySet<AirAmbulanceStatus> = new Set([
  AirAmbulanceStatus.ACCEPTED,
  AirAmbulanceStatus.CONFIRMED,
  AirAmbulanceStatus.COMPLETED,
]);

/** Medical documents one request may hold. */
export const MAX_DOCUMENTS = 10;

/** Attempts at a fresh reference before giving up (31^6 codes). */
const REFERENCE_ATTEMPTS = 5;

export function notFound(): AppException {
  return new AppException(
    'NOT_FOUND',
    'Air ambulance request not found.',
    HttpStatus.NOT_FOUND,
  );
}

type RequestRow = Pick<
  AirAmbulanceRequest,
  'requesterId' | 'assignedToId' | 'selectedOperatorId' | 'status'
>;

/**
 * Who may read a request, and who may also read its medical details
 * (docs/architecture/security-rbac.md, "Role by capability"):
 * - the requester: both;
 * - operations: the request; medical details only as its assigned owner;
 * - the super administrator: both;
 * - an operator administrator of the selected operator: both, from the
 *   customer's acceptance onwards (before it, operators see offers, W4-5);
 * - everyone else (finance, operator staff, other customers and operators):
 *   neither, and the request answers 404.
 * `callerOperatorId` is the caller's organisation, for operator roles.
 */
export function readAccess(
  row: RequestRow,
  actor: AirAmbulanceActor,
  callerOperatorId: string | null,
): { request: boolean; medical: boolean } {
  switch (actor.role) {
    case Role.CUSTOMER: {
      const own = row.requesterId === actor.id;
      return { request: own, medical: own };
    }
    case Role.OPS:
      return { request: true, medical: row.assignedToId === actor.id };
    case Role.SUPER_ADMIN:
      return { request: true, medical: true };
    case Role.OPERATOR_ADMIN: {
      const selected =
        callerOperatorId !== null &&
        row.selectedOperatorId === callerOperatorId &&
        ACCEPTED_OR_LATER.has(row.status);
      return { request: selected, medical: selected };
    }
    default:
      return { request: false, medical: false };
  }
}

/**
 * Air ambulance requests (M11). A request is a request until operations and
 * the operator verify the mission: nothing here confirms one (rule 7).
 * Medical details are never logged, listed or put in the audit trail
 * (rule 8); every read of them is audited.
 */
@Injectable()
export class AirAmbulanceService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly cipher: FieldCipher,
    private readonly operators: OperatorsService,
    private readonly locations: LocationsService,
    private readonly documents: DocumentsService,
    private readonly events: NotificationEventsService,
    private readonly aircraft: AircraftService,
    private readonly users: UsersService,
  ) {}

  onModuleInit(): void {
    // Who may download a medical document: exactly who may read the
    // request's medical details. Every download is audited first, so one
    // that cannot be audited is refused (rule 8).
    this.documents.registerAccessCheck(
      FilePurpose.AIR_AMBULANCE_DOCUMENT,
      async (file, user) => {
        const document = await this.prisma.airAmbulanceDocument.findUnique({
          where: { fileId: file.id },
          select: { request: true },
        });
        if (!document) return false;
        const actor = { id: user.id, role: user.role };
        const access = readAccess(
          document.request,
          actor,
          await this.operatorOf(actor),
        );
        if (!access.medical) return false;
        await this.audit.record({
          action: 'air_ambulance_request.medical_read',
          entityType: 'AirAmbulanceRequest',
          entityId: document.request.id,
          after: { fileId: file.id },
          actor,
        });
        return true;
      },
    );
  }

  /**
   * 400 when both ends are the same place, 404 when either is not an active
   * location (never a raw foreign-key error).
   */
  private async assertLocations(input: {
    originLocationId: string;
    destinationLocationId: string;
  }): Promise<void> {
    if (input.originLocationId === input.destinationLocationId) {
      throw new AppException(
        'VALIDATION_ERROR',
        'The destination must differ from the origin.',
        HttpStatus.BAD_REQUEST,
        [{ field: 'destinationLocationId', issue: 'same as the origin' }],
      );
    }
    for (const field of [
      'originLocationId',
      'destinationLocationId',
    ] as const) {
      if (!(await this.locations.isActive(input[field]))) {
        throw new AppException(
          'NOT_FOUND',
          'Location not found.',
          HttpStatus.NOT_FOUND,
          [{ field, issue: 'no active location with this id' }],
        );
      }
    }
  }

  /**
   * Records a request for the caller, with its medical details encrypted,
   * the first timeline entry and an audit entry (status only). `claim` is
   * the request's `Idempotency-Key`, committed with the request (rule 5).
   */
  async create(
    actor: AirAmbulanceActor,
    input: CreateAirAmbulanceRequestInput,
    claim: IdempotencyClaim,
  ): Promise<AirAmbulanceRequestView> {
    const { medical } = input;
    await this.assertLocations(input);
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          // First: the requester's lock, refused once the account is erased.
          await this.users.lockLiveCustomer(actor.id, tx);
          await markIdempotencyCommitted(tx, claim);
          const row = await tx.airAmbulanceRequest.create({
            data: {
              reference: airAmbulanceReference(),
              requesterId: actor.id,
              contactName: input.contactName,
              contactPhone: input.contactPhone,
              contactEmail: input.contactEmail ?? null,
              emergencyContactName: input.emergencyContactName ?? null,
              emergencyContactPhone: input.emergencyContactPhone ?? null,
              originLocationId: input.originLocationId,
              destinationLocationId: input.destinationLocationId,
              // Encrypted: a hospital is close to medical data (W4-4 review).
              pickupAddress: this.encryptOptional(input.pickupAddress),
              destinationFacility: this.encryptOptional(
                input.destinationFacility,
              ),
              preferredAt: input.preferredAt,
              patientCount: input.patientCount,
              accompanyingPersons: input.accompanyingPersons,
              status: AirAmbulanceStatus.SUBMITTED,
              medical: {
                create: {
                  patientCondition: this.cipher.encrypt(
                    medical.patientCondition,
                  ),
                  mobility: medical.mobility,
                  stretcherRequired: medical.stretcherRequired,
                  oxygenRequired: medical.oxygenRequired,
                  medicalStaffRequired: this.encryptOptional(
                    medical.medicalStaffRequired,
                  ),
                  equipmentRequired: this.encryptOptional(
                    medical.equipmentRequired,
                  ),
                  specialisedCare: this.encryptOptional(
                    medical.specialisedCare,
                  ),
                  notes: this.encryptOptional(medical.notes),
                },
              },
            },
          });
          await tx.airAmbulanceRequestEvent.create({
            data: {
              requestId: row.id,
              fromStatus: null,
              toStatus: AirAmbulanceStatus.SUBMITTED,
              actorId: actor.id,
              actorRole: actor.role,
            },
          });
          // The status only: contact and medical details stay out (rule 8).
          await this.audit.record(
            {
              action: 'air_ambulance_request.create',
              entityType: 'AirAmbulanceRequest',
              entityId: row.id,
              after: { status: row.status },
              actor,
            },
            tx,
          );
          // Operations only, reference only: no contact or medical detail (rule 8).
          await this.events.notify(tx, 'air_ambulance.received', {
            reference: row.reference,
          });
          return toView(row);
        });
      } catch (error) {
        const clash =
          (error as { code?: unknown }).code === 'P2002' &&
          attempt < REFERENCE_ATTEMPTS;
        if (!clash) throw error;
      }
    }
  }

  /**
   * One request as the caller may see it: 404 when they may not see it at
   * all; `medical` null when they may see the request but not its medical
   * details. Returning medical details writes an audit entry first, so a
   * read that cannot be audited fails.
   */
  async findOne(
    reference: string,
    actor: AirAmbulanceActor,
  ): Promise<AirAmbulanceRequestDetail> {
    const row = await this.prisma.airAmbulanceRequest.findUnique({
      where: { reference },
    });
    if (!row) throw notFound();
    const access = readAccess(row, actor, await this.operatorOf(actor));
    if (!access.request) throw notFound();
    if (!access.medical) return { ...toView(row), medical: null };

    const medical = await this.prisma.airAmbulanceMedical.findUnique({
      where: { requestId: row.id },
      include: {
        request: {
          select: {
            documents: {
              select: { fileId: true },
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            },
          },
        },
      },
    });
    if (!medical) return { ...toView(row), medical: null };
    await this.audit.record({
      action: 'air_ambulance_request.medical_read',
      entityType: 'AirAmbulanceRequest',
      entityId: row.id,
      actor,
    });
    return {
      ...toView(row),
      pickupAddress: this.decryptPlace(row.pickupAddress),
      destinationFacility: this.decryptPlace(row.destinationFacility),
      medical: {
        ...this.decryptMedical(medical),
        documentFileIds: medical.request.documents.map((d) => d.fileId),
      },
    };
  }

  /** The caller's own requests, newest first. Never any medical data. */
  async listOwn(
    actor: AirAmbulanceActor,
    page: number,
    pageSize: number,
  ): Promise<{ items: AirAmbulanceRequestView[]; total: number }> {
    const where = { requesterId: actor.id };
    const [rows, total] = await Promise.all([
      this.prisma.airAmbulanceRequest.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.airAmbulanceRequest.count({ where }),
    ]);
    return { items: rows.map(toView), total };
  }

  /**
   * The missions an operator administrator's organisation was selected for,
   * from the customer's acceptance on, newest first (W4-6). Only an approved
   * operator's administrators (409 `OPERATOR_NOT_APPROVED`, as the other
   * operator routes). Never any medical data.
   */
  async listForOperator(
    actor: AirAmbulanceActor,
    page: number,
    pageSize: number,
  ): Promise<{ items: AirAmbulanceRequestView[]; total: number }> {
    const operatorId = await this.operatorOf(actor);
    if (operatorId === null) {
      throw new AppException(
        'OPERATOR_NOT_APPROVED',
        'Only an approved operator can see its air ambulance missions.',
        HttpStatus.CONFLICT,
      );
    }
    const where = {
      selectedOperatorId: operatorId,
      status: { in: [...ACCEPTED_OR_LATER] },
    };
    const [rows, total] = await Promise.all([
      this.prisma.airAmbulanceRequest.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.airAmbulanceRequest.count({ where }),
    ]);
    return { items: rows.map(toView), total };
  }

  /**
   * Operators operations may quote: approved, with at least one approved
   * air ambulance aircraft (owner decision 2026-11-20, W4-6), by name.
   */
  async eligibleOperators(): Promise<{ id: string; name: string }[]> {
    const approved = await this.operators.approvedForMatching(
      await this.aircraft.airAmbulanceOperatorIds(),
    );
    return [...approved]
      .map(([id, operator]) => ({ id, name: operator.name }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  /**
   * The operations queue, newest first. `assignee` is a user id, `me` or
   * `none` (unassigned). Never any medical data.
   */
  async queue(
    actor: AirAmbulanceActor,
    filter: {
      status?: AirAmbulanceStatus;
      assignee?: string;
      page: number;
      pageSize: number;
    },
  ): Promise<{ items: AirAmbulanceRequestView[]; total: number }> {
    const assignedToId =
      filter.assignee === undefined
        ? undefined
        : filter.assignee === 'none'
          ? null
          : filter.assignee === 'me'
            ? actor.id
            : filter.assignee;
    const where = {
      ...(filter.status ? { status: filter.status } : {}),
      ...(assignedToId !== undefined ? { assignedToId } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.airAmbulanceRequest.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (filter.page - 1) * filter.pageSize,
        take: filter.pageSize,
      }),
      this.prisma.airAmbulanceRequest.count({ where }),
    ]);
    return { items: rows.map(toView), total };
  }

  /** Location names by id, active or not. */
  async locationNames(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    const active = await this.locations.activeSummaries(unique);
    const names = new Map([...active].map(([id, row]) => [id, row.name]));
    for (const id of unique.filter((entry) => !names.has(entry))) {
      const row = await this.locations.summary(id);
      if (row) names.set(id, row.name);
    }
    return names;
  }

  /** An operator's display name, whatever its status. */
  async operatorName(id: string | null): Promise<string | null> {
    if (!id) return null;
    return (await this.operators.names([id])).get(id) ?? null;
  }

  /** The request's timeline, oldest first. Payloads hold no medical data. */
  async timeline(requestId: string): Promise<
    {
      fromStatus: AirAmbulanceStatus | null;
      toStatus: AirAmbulanceStatus;
      actorId: string | null;
      actorRole: Role | null;
      payload: unknown;
      createdAt: Date;
    }[]
  > {
    return this.prisma.airAmbulanceRequestEvent.findMany({
      where: { requestId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        fromStatus: true,
        toStatus: true,
        actorId: true,
        actorRole: true,
        payload: true,
        createdAt: true,
      },
    });
  }

  /** The current feasibility checklist as recorded (raw jsonb). */
  async feasibilityOf(requestId: string): Promise<unknown> {
    const row = await this.prisma.airAmbulanceRequest.findUnique({
      where: { id: requestId },
      select: { feasibility: true },
    });
    return row?.feasibility ?? null;
  }

  /** Names and sizes of attached medical documents (medical readers only). */
  async documentInfo(fileIds: string[]) {
    const files = await this.documents.describe(fileIds);
    return fileIds.flatMap((id) => {
      const file = files.get(id);
      return file
        ? [{ fileId: id, fileName: file.fileName, sizeBytes: file.sizeBytes }]
        : [];
    });
  }

  /**
   * Attaches an uploaded medical document (`FilePurpose`
   * `AIR_AMBULANCE_DOCUMENT`, reserved by the requester) to their own open
   * request. Another customer's request is 404; a closed one 409.
   */
  async attachDocument(
    actor: AirAmbulanceActor,
    reference: string,
    fileId: string,
  ): Promise<{ fileId: string; fileName: string; sizeBytes: number }> {
    return this.prisma.$transaction(async (tx) => {
      // Locked, so two attachments at once cannot pass the limit together.
      const rows = await tx.$queryRaw<
        { id: string; requesterId: string; status: AirAmbulanceStatus }[]
      >`SELECT id, "requesterId", status FROM "AirAmbulanceRequest"
        WHERE reference = ${reference} FOR UPDATE`;
      const row = rows[0];
      if (!row || row.requesterId !== actor.id) throw notFound();
      if (CLOSED.has(row.status)) {
        throw new AppException(
          'AIR_AMBULANCE_CLOSED',
          'This request is closed.',
          HttpStatus.CONFLICT,
        );
      }
      const held = await tx.airAmbulanceDocument.count({
        where: { requestId: row.id },
      });
      if (held >= MAX_DOCUMENTS) {
        throw new AppException(
          'AIR_AMBULANCE_DOCUMENT_LIMIT_REACHED',
          `A request can hold up to ${MAX_DOCUMENTS} documents.`,
          HttpStatus.CONFLICT,
        );
      }
      const file = await this.documents.claim(
        fileId,
        actor.id,
        FilePurpose.AIR_AMBULANCE_DOCUMENT,
        tx,
      );
      await tx.airAmbulanceDocument.create({
        data: { requestId: row.id, fileId: file.id },
      });
      // Ids only: the file name can describe the patient (rule 8).
      await this.audit.record(
        {
          action: 'air_ambulance_document.add',
          entityType: 'AirAmbulanceRequest',
          entityId: row.id,
          after: { fileId: file.id },
          actor,
        },
        tx,
      );
      return {
        fileId: file.id,
        fileName: file.fileName,
        sizeBytes: file.sizeBytes,
      };
    });
  }

  /** The caller's organisation, for an operator administrator. */
  private async operatorOf(actor: AirAmbulanceActor): Promise<string | null> {
    if (actor.role !== Role.OPERATOR_ADMIN) return null;
    try {
      // Only an approved operator's administrators read a request: a
      // suspended operator loses access at once (W4-4 review).
      const operator = await this.operators.forMember(actor.id);
      return operator.status === OperatorStatus.APPROVED ? operator.id : null;
    } catch {
      // No membership: not any operator's administrator.
      return null;
    }
  }

  /**
   * A timeline entry's payload for operations (`adminDetail`): the revision
   * reason of a replaced quotation decrypted, everything else as stored.
   */
  eventPayloadForOperations(payload: unknown): Record<string, unknown> | null {
    if (typeof payload !== 'object' || payload === null) return null;
    const entry = payload as Record<string, unknown>;
    const reason = entry.revisionReason;
    return typeof reason === 'string' && isEncrypted(reason)
      ? { ...entry, revisionReason: this.cipher.decrypt(reason) }
      : entry;
  }

  /**
   * A collection or receiving place. Rows written before it was encrypted
   * (none outside development) are returned as stored.
   */
  private decryptPlace(stored: string | null): string | null {
    if (stored === null) return null;
    return isEncrypted(stored) ? this.cipher.decrypt(stored) : stored;
  }

  private encryptOptional(plain: string | undefined): string | null {
    return plain === undefined ? null : this.cipher.encrypt(plain);
  }

  private decryptMedical(
    row: AirAmbulanceMedical,
  ): Omit<MedicalDetailsView, 'documentFileIds'> {
    const decrypt = (stored: string | null) =>
      stored === null ? null : this.cipher.decrypt(stored);
    return {
      patientCondition: this.cipher.decrypt(row.patientCondition),
      mobility: row.mobility,
      stretcherRequired: row.stretcherRequired,
      oxygenRequired: row.oxygenRequired,
      medicalStaffRequired: decrypt(row.medicalStaffRequired),
      equipmentRequired: decrypt(row.equipmentRequired),
      specialisedCare: decrypt(row.specialisedCare),
      notes: decrypt(row.notes),
    };
  }
}

export function toView(row: AirAmbulanceRequest): AirAmbulanceRequestView {
  return {
    id: row.id,
    reference: row.reference,
    status: row.status,
    contactName: row.contactName,
    contactPhone: row.contactPhone,
    contactEmail: row.contactEmail,
    emergencyContactName: row.emergencyContactName,
    emergencyContactPhone: row.emergencyContactPhone,
    originLocationId: row.originLocationId,
    destinationLocationId: row.destinationLocationId,
    // Encrypted and as restricted as the medical details: only `findOne`
    // returns them, to those who may read the medical details.
    pickupAddress: null,
    destinationFacility: null,
    preferredAt: row.preferredAt,
    patientCount: row.patientCount,
    accompanyingPersons: row.accompanyingPersons,
    assignedToId: row.assignedToId,
    selectedOperatorId: row.selectedOperatorId,
    quote:
      row.quoteAmountMinor !== null && row.quoteCurrency && row.quotedAt
        ? {
            amountMinor: row.quoteAmountMinor,
            currency: row.quoteCurrency,
            conditions: row.quoteConditions,
            quotedAt: row.quotedAt,
          }
        : null,
    confirmedAt: row.confirmedAt,
    completedAt: row.completedAt,
    closedAt: row.closedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

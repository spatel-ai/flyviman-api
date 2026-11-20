import { HttpStatus, Injectable } from '@nestjs/common';
import { FieldCipher } from '../../common/crypto/field-cipher.js';
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
  type PatientMobility,
  Role,
} from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OperatorsService } from '../operators/operators.service.js';

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
  pickupAddress: string | null;
  destinationFacility: string | null;
  preferredAt: Date;
  patientCount: number;
  accompanyingPersons: number;
  assignedToId: string | null;
  selectedOperatorId: string | null;
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

/** Attempts at a fresh reference before giving up (31^6 codes). */
const REFERENCE_ATTEMPTS = 5;

function notFound(): AppException {
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
export class AirAmbulanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly cipher: FieldCipher,
    private readonly operators: OperatorsService,
  ) {}

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
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.prisma.$transaction(async (tx) => {
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
              pickupAddress: input.pickupAddress ?? null,
              destinationFacility: input.destinationFacility ?? null,
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
    id: string,
    actor: AirAmbulanceActor,
  ): Promise<AirAmbulanceRequestDetail> {
    const row = await this.prisma.airAmbulanceRequest.findUnique({
      where: { id },
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
      medical: {
        ...this.decryptMedical(medical),
        documentFileIds: medical.request.documents.map((d) => d.fileId),
      },
    };
  }

  /** The caller's organisation, for an operator administrator. */
  private async operatorOf(actor: AirAmbulanceActor): Promise<string | null> {
    if (actor.role !== Role.OPERATOR_ADMIN) return null;
    try {
      return (await this.operators.forMember(actor.id)).id;
    } catch {
      // No membership: not any operator's administrator.
      return null;
    }
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

function toView(row: AirAmbulanceRequest): AirAmbulanceRequestView {
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
    pickupAddress: row.pickupAddress,
    destinationFacility: row.destinationFacility,
    preferredAt: row.preferredAt,
    patientCount: row.patientCount,
    accompanyingPersons: row.accompanyingPersons,
    assignedToId: row.assignedToId,
    selectedOperatorId: row.selectedOperatorId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

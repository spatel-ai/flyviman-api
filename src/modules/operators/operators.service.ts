import { HttpStatus, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Paginated } from '../../common/dto/paginated.js';
import { AppException } from '../../common/errors/app.exception.js';
import { Prisma } from '../../generated/prisma/client.js';
import {
  DocumentVerificationStatus,
  FilePurpose,
  OperatorDocumentType,
  OperatorStatus,
  Role,
} from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import {
  assertAcceptablePassword,
  hashPassword,
} from '../../common/crypto/password.js';
import { assertDocumentDates } from '../../common/document-dates.js';
import { uniqueOrNull } from '../../common/errors/unique.js';
import {
  PendingRegistration,
  VerificationSent,
  VerificationService,
} from '../auth/verification.service.js';
import { DocumentsService } from '../documents/documents.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { ConsentsService } from '../users/consents.service.js';
import {
  Identifier,
  UserAccount,
  UsersService,
} from '../users/users.service.js';
import {
  adminAccess,
  OperatorAccess,
  parsePermissions,
  staffAccess,
} from './operator-access.js';
import type { ExpiryCandidate } from '../compliance/expiry.js';
import { nextOperatorStatus, OperatorAction } from './operator-transitions.js';

export type OperatorRecord = Prisma.OperatorGetPayload<object>;
export type OperatorDocumentRecord =
  Prisma.OperatorDocumentGetPayload<object> & {
    fileName: string;
  };

/**
 * Compliance documents an application needs before it can be submitted, and
 * verified before it can be approved. Per-category requirements are an open
 * decision (docs/open-decisions.md, item 14).
 */
export const REQUIRED_DOCUMENTS: OperatorDocumentType[] = [
  OperatorDocumentType.AOC,
  OperatorDocumentType.INSURANCE,
];

/** Upper bound on compliance documents held by one operator. */
export const MAX_OPERATOR_DOCUMENTS = 30;

interface PendingOperator extends PendingRegistration {
  kind: 'operator';
  legalName: string;
  contactName: string;
  contactPhone: string | null;
  passwordHash: string;
}

/**
 * Fields that were part of what operations reviewed. They are frozen once
 * an operator has been approved, so an approved operator cannot rename
 * itself or add a category (air ambulance, for example) without review.
 */
export const REVIEWED_FIELDS = [
  'legalName',
  'tradingName',
  'registrationNumber',
  'taxNumber',
  'serviceCategories',
] as const;

const JSON_FIELDS = ['businessAddress', 'billingAddress'] as const;

const INTERNAL_READERS: Role[] = [
  Role.OPS,
  Role.FINANCE_ADMIN,
  Role.SUPER_ADMIN,
];

const AUDIT_ACTION: Record<OperatorAction, string> = {
  submit: 'operator.submit',
  approve: 'operator.approve',
  reject: 'operator.reject',
  suspend: 'operator.suspend',
  reinstate: 'operator.reinstate',
};

const NOTIFICATION: Record<OperatorAction, string> = {
  submit: 'operator.submitted',
  approve: 'operator.approved',
  reject: 'operator.rejected',
  suspend: 'operator.suspended',
  reinstate: 'operator.reinstated',
};

function notFound(what = 'Operator'): AppException {
  return new AppException(
    'NOT_FOUND',
    `${what} not found.`,
    HttpStatus.NOT_FOUND,
  );
}

/** Owns Operator, OperatorMember and OperatorDocument. */
@Injectable()
export class OperatorsService implements OnModuleInit {
  private readonly logger = new Logger(OperatorsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    private readonly consents: ConsentsService,
    private readonly verification: VerificationService,
    private readonly documents: DocumentsService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.verification.registerCompletion('operator', (pending, identifier) =>
      this.createOperator(pending as PendingOperator, identifier),
    );

    // Who may download an operator's compliance documents
    // (docs/architecture/security-rbac.md): the operator's own members, and
    // operations, finance and super administrators.
    this.documents.registerAccessCheck(
      FilePurpose.OPERATOR_DOCUMENT,
      async (file, user) => {
        if (INTERNAL_READERS.includes(user.role)) return true;
        // Listing documents is for the operator's administrators only, so
        // downloading is too.
        if (user.role !== Role.OPERATOR_ADMIN) return false;
        const document = await this.prisma.operatorDocument.findFirst({
          where: {
            fileId: file.id,
            operator: { members: { some: { userId: user.id } } },
          },
          select: { id: true },
        });
        return document !== null;
      },
    );
  }

  // --- Registration -------------------------------------------------------

  /**
   * Starts an operator registration. Nothing is stored until the email code
   * is verified; then the organisation is created in DRAFT with its first
   * administrator. Answers the same whether or not the email is registered.
   */
  async register(input: {
    legalName: string;
    contactName: string;
    email: string;
    password: string;
    phone?: string;
  }): Promise<VerificationSent> {
    assertAcceptablePassword(input.password);
    const identifier = { email: input.email };
    const pending: PendingOperator = {
      kind: 'operator',
      legalName: input.legalName,
      contactName: input.contactName,
      contactPhone: input.phone ?? null,
      passwordHash: await hashPassword(input.password),
    };
    await this.verification.throttle(identifier);
    const taken = await this.users.findAccountBy(identifier);
    return this.verification.start(identifier, taken ? {} : { pending });
  }

  private createOperator(
    pending: PendingOperator,
    identifier: Identifier,
  ): Promise<UserAccount | null> {
    return uniqueOrNull(() =>
      this.prisma.$transaction(async (tx) => {
        if (await this.users.findAccountBy(identifier, tx)) return null;
        const user = await this.users.create(
          {
            ...identifier,
            passwordHash: pending.passwordHash,
            role: Role.OPERATOR_ADMIN,
            verified: true,
          },
          tx,
        );
        const operator = await tx.operator.create({
          data: {
            legalName: pending.legalName,
            contactName: pending.contactName,
            contactEmail: user.email!,
            contactPhone: pending.contactPhone,
          },
        });
        await tx.operatorMember.create({
          data: { operatorId: operator.id, userId: user.id },
        });
        await this.consents.recordRegistration(user.id, tx);
        await this.audit.record(
          {
            action: 'operator.register',
            entityType: 'Operator',
            entityId: operator.id,
            actor: { id: user.id, role: Role.OPERATOR_ADMIN },
            after: { status: OperatorStatus.DRAFT },
          },
          tx,
        );
        return user;
      }),
    );
  }

  // --- The operator's own profile ----------------------------------------

  /** The organisation the user belongs to. */
  async forMember(userId: string): Promise<OperatorRecord> {
    const member = await this.prisma.operatorMember.findUnique({
      where: { userId },
      include: { operator: true },
    });
    if (!member) throw notFound();
    return member.operator;
  }

  /**
   * Which of these ids are not aircraft of the operator. The aircraft module
   * answers this (it owns the table and depends on this module), registered
   * at start-up; until then every id is unknown (fail closed).
   */
  private aircraftCheck: (
    operatorId: string,
    ids: string[],
  ) => Promise<string[]> = (_operatorId, ids) => Promise.resolve(ids);

  registerAircraftCheck(
    check: (operatorId: string, ids: string[]) => Promise<string[]>,
  ): void {
    this.aircraftCheck = check;
  }

  unknownAircraft(operatorId: string, ids: string[]): Promise<string[]> {
    return this.aircraftCheck(operatorId, ids);
  }

  /**
   * The caller's organisation and what they may do in it, read from the
   * database on every request so a permission change applies at once
   * (operator-access.ts, D-049).
   */
  async accessFor(
    user: AuthUser,
  ): Promise<{ operator: OperatorRecord; access: OperatorAccess }> {
    const member = await this.prisma.operatorMember.findUnique({
      where: { userId: user.id },
      include: { operator: true },
    });
    if (!member) throw notFound();
    if (user.role === Role.OPERATOR_ADMIN) {
      return {
        operator: member.operator,
        access: adminAccess(member.operatorId),
      };
    }
    if (user.role === Role.OPERATOR_STAFF) {
      return {
        operator: member.operator,
        access: staffAccess(
          member.operatorId,
          parsePermissions(member.permissions),
        ),
      };
    }
    throw notFound();
  }

  /**
   * Customer-facing names of the operators among `ids` that are approved
   * (business rule 4). Search uses it: an operator missing from the map is
   * not offered.
   */
  async approvedNames(ids: string[]): Promise<Map<string, string>> {
    const rows = await this.prisma.operator.findMany({
      where: { id: { in: ids }, status: OperatorStatus.APPROVED },
      select: { id: true, legalName: true, tradingName: true },
    });
    return new Map(
      rows.map((row) => [row.id, row.tradingName ?? row.legalName]),
    );
  }

  /**
   * An operator's status. Inside a transaction the row is share-locked, so a
   * suspension cannot commit between this read and the caller's change.
   */
  async statusOf(
    operatorId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<OperatorStatus> {
    if (tx) {
      const rows = await tx.$queryRaw<{ status: OperatorStatus }[]>`
        SELECT status FROM "Operator" WHERE id = ${operatorId}::uuid FOR SHARE`;
      if (rows.length === 0) throw notFound();
      return rows[0].status;
    }
    const row = await this.prisma.operator.findUnique({
      where: { id: operatorId },
      select: { status: true },
    });
    if (!row) throw notFound();
    return row.status;
  }

  /**
   * Compliance documents for the expiry job and page (compliance module,
   * D-072): every non-rejected copy of each type that has a copy expiring by
   * `until`, for live operators (approved or suspended), so the caller can
   * tell a renewed copy from the one it replaces.
   */
  async expiryCandidates(until: Date): Promise<ExpiryCandidate[]> {
    const live = [OperatorStatus.APPROVED, OperatorStatus.SUSPENDED];
    const notRejected = { not: DocumentVerificationStatus.REJECTED };
    const expiring = await this.prisma.operatorDocument.findMany({
      where: {
        expiresAt: { lte: until },
        verificationStatus: notRejected,
        operator: { status: { in: live } },
      },
      select: { operatorId: true, type: true },
      distinct: ['operatorId', 'type'],
    });
    if (expiring.length === 0) return [];
    const rows = await this.prisma.operatorDocument.findMany({
      where: { verificationStatus: notRejected, OR: expiring },
      include: { operator: { select: { legalName: true, tradingName: true } } },
    });
    return rows.map((row) => ({
      kind: 'OPERATOR',
      documentId: row.id,
      type: row.type,
      expiresAt: row.expiresAt,
      verificationStatus: row.verificationStatus,
      operatorId: row.operatorId,
      operatorName: row.operator.tradingName ?? row.operator.legalName,
      aircraftId: null,
      registration: null,
    }));
  }

  /** The operator's administrators, who receive fleet notifications. */
  async administrators(
    operatorId: string,
  ): Promise<{ id: string; email: string | null }[]> {
    const members = await this.prisma.operatorMember.findMany({
      where: { operatorId, user: { role: Role.OPERATOR_ADMIN } },
      select: { user: { select: { id: true, email: true } } },
    });
    return members.map((member) => member.user);
  }

  async updateProfile(
    userId: string,
    changes: Prisma.OperatorUpdateInput,
  ): Promise<OperatorRecord> {
    const operator = await this.forMember(userId);
    if (operator.status === OperatorStatus.PENDING_REVIEW) {
      throw new AppException(
        'OPERATOR_UNDER_REVIEW',
        'The application is under review and cannot be changed until a decision is made.',
        HttpStatus.CONFLICT,
      );
    }
    const frozen =
      operator.status === OperatorStatus.APPROVED ||
      operator.status === OperatorStatus.SUSPENDED;
    const locked = REVIEWED_FIELDS.filter(
      (field) => frozen && changes[field] !== undefined,
    );
    if (locked.length > 0) {
      throw new AppException(
        'OPERATOR_FIELD_LOCKED',
        'Company name, registration details and service categories cannot be changed after approval. Contact support.',
        HttpStatus.CONFLICT,
        locked.map((field) => ({ field, issue: 'cannot be changed' })),
      );
    }

    // A cleared address is stored as a database NULL.
    const data: Prisma.OperatorUpdateInput = Object.fromEntries(
      Object.entries(changes).filter(([, value]) => value !== undefined),
    );
    for (const field of JSON_FIELDS) {
      if (data[field] === null) data[field] = Prisma.DbNull;
    }

    return this.prisma.$transaction(async (tx) => {
      // The status is rechecked in the update itself, so an edit cannot
      // land after a submission made at the same moment.
      const { count } = await tx.operator.updateMany({
        where: { id: operator.id, status: operator.status },
        data: data as Prisma.OperatorUpdateManyMutationInput,
      });
      if (count !== 1) {
        throw new AppException(
          'OPERATOR_UNDER_REVIEW',
          'The application changed while you were editing. Reload and try again.',
          HttpStatus.CONFLICT,
        );
      }
      // Which fields changed, not their values: contact details are
      // personal data and do not belong in the audit trail.
      await this.audit.record(
        {
          action: 'operator.profile_update',
          entityType: 'Operator',
          entityId: operator.id,
          after: { fields: Object.keys(data).sort() },
        },
        tx,
      );
      return tx.operator.findUniqueOrThrow({ where: { id: operator.id } });
    });
  }

  /** What the application still needs before it can be submitted. */
  async missing(operator: OperatorRecord): Promise<string[]> {
    const missing: string[] = [];
    if (!operator.registrationNumber) missing.push('registrationNumber');
    if (!operator.businessAddress) missing.push('businessAddress');
    if (operator.serviceCategories.length === 0) {
      missing.push('serviceCategories');
    }
    const held = await this.prisma.operatorDocument.findMany({
      where: {
        operatorId: operator.id,
        verificationStatus: { not: DocumentVerificationStatus.REJECTED },
      },
      select: { type: true },
    });
    for (const type of REQUIRED_DOCUMENTS) {
      if (!held.some((document) => document.type === type)) {
        missing.push(`document:${type}`);
      }
    }
    return missing;
  }

  // --- Documents ----------------------------------------------------------

  async listDocuments(operatorId: string): Promise<OperatorDocumentRecord[]> {
    const rows = await this.prisma.operatorDocument.findMany({
      where: { operatorId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const files = await this.documents.describe(rows.map((row) => row.fileId));
    return rows.map((row) => ({
      ...row,
      fileName: files.get(row.fileId)?.fileName ?? 'document',
    }));
  }

  async addDocument(
    userId: string,
    input: {
      type: OperatorDocumentType;
      fileId: string;
      issuedAt?: string | null;
      expiresAt?: string | null;
    },
  ): Promise<OperatorDocumentRecord> {
    const operator = await this.forMember(userId);
    this.assertDocumentsEditable(operator);
    assertDocumentDates(input.issuedAt, input.expiresAt);
    const held = await this.prisma.operatorDocument.count({
      where: { operatorId: operator.id },
    });
    if (held >= MAX_OPERATOR_DOCUMENTS) {
      throw new AppException(
        'OPERATOR_DOCUMENT_LIMIT_REACHED',
        `An operator can hold up to ${MAX_OPERATOR_DOCUMENTS} documents. Remove one that is no longer needed.`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const file = await this.documents.claim(
        input.fileId,
        userId,
        FilePurpose.OPERATOR_DOCUMENT,
        tx,
      );
      const row = await tx.operatorDocument.create({
        data: {
          operatorId: operator.id,
          type: input.type,
          fileId: file.id,
          issuedAt: input.issuedAt ? new Date(input.issuedAt) : null,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        },
      });
      await this.audit.record(
        {
          action: 'operator_document.add',
          entityType: 'OperatorDocument',
          entityId: row.id,
          after: { operatorId: operator.id, type: row.type },
        },
        tx,
      );
      return { ...row, fileName: file.fileName };
    });
  }

  async removeDocument(userId: string, documentId: string): Promise<void> {
    const operator = await this.forMember(userId);
    // Scoped to the caller's organisation: another operator's document is
    // indistinguishable from one that does not exist.
    const document = await this.prisma.operatorDocument.findFirst({
      where: { id: documentId, operatorId: operator.id },
    });
    if (!document) throw notFound('Document');
    this.assertDocumentsEditable(operator);
    if (
      document.verificationStatus === DocumentVerificationStatus.VERIFIED &&
      operator.status !== OperatorStatus.DRAFT &&
      operator.status !== OperatorStatus.REJECTED
    ) {
      throw new AppException(
        'OPERATOR_DOCUMENT_LOCKED',
        'A verified document cannot be removed. Upload its replacement instead.',
        HttpStatus.CONFLICT,
      );
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.operatorDocument.delete({ where: { id: document.id } });
      await this.audit.record(
        {
          action: 'operator_document.remove',
          entityType: 'OperatorDocument',
          entityId: document.id,
          before: { operatorId: operator.id, type: document.type },
        },
        tx,
      );
    });
    // The document is gone for the operator either way. A file that could
    // not be removed is left for a later sweep.
    await this.documents.remove(document.fileId).catch((error: unknown) => {
      this.logger.error(
        `Could not remove the stored file of a deleted document: ${
          error instanceof Error ? error.name : 'unknown error'
        }`,
      );
    });
  }

  private assertDocumentsEditable(operator: OperatorRecord): void {
    if (operator.status === OperatorStatus.PENDING_REVIEW) {
      throw new AppException(
        'OPERATOR_UNDER_REVIEW',
        'The application is under review and cannot be changed until a decision is made.',
        HttpStatus.CONFLICT,
      );
    }
  }

  // --- State machine ------------------------------------------------------

  /**
   * The only place an operator's status changes. Checks the transition and
   * the actor's role, writes the audit record in the same transaction, then
   * notifies the operator's administrators.
   */
  async transition(
    actor: AuthUser,
    operatorId: string,
    action: OperatorAction,
    reason?: string,
  ): Promise<OperatorRecord> {
    const updated = await this.prisma.$transaction(async (tx) => {
      const operator = await tx.operator.findUnique({
        where: { id: operatorId },
      });
      if (!operator) throw notFound();

      const next = nextOperatorStatus(
        action,
        operator.status,
        actor.role,
        reason,
      );
      if ('refused' in next) throw this.refusal(next.refused, operator, action);

      if (action === 'submit') {
        const missing = await this.missing(operator);
        if (missing.length > 0) {
          throw new AppException(
            'OPERATOR_PROFILE_INCOMPLETE',
            'Complete the application before submitting it.',
            HttpStatus.UNPROCESSABLE_ENTITY,
            missing.map((field) => ({ field, issue: 'is required' })),
          );
        }
      }
      if (action === 'approve') {
        const verified = await tx.operatorDocument.findMany({
          where: {
            operatorId,
            verificationStatus: DocumentVerificationStatus.VERIFIED,
          },
          select: { type: true },
        });
        const unverified = REQUIRED_DOCUMENTS.filter(
          (type) => !verified.some((document) => document.type === type),
        );
        if (unverified.length > 0) {
          throw new AppException(
            'OPERATOR_DOCUMENTS_UNVERIFIED',
            'Verify the required documents before approving this operator.',
            HttpStatus.UNPROCESSABLE_ENTITY,
            unverified.map((type) => ({
              field: `document:${type}`,
              issue: 'is not verified',
            })),
          );
        }
      }

      const reviewed = action !== 'submit';
      // Conditional on the status just read: of two reviewers acting at the
      // same moment, only one decision is applied and audited.
      const { count } = await tx.operator.updateMany({
        where: { id: operatorId, status: operator.status },
        data: {
          status: next.to,
          ...(action === 'submit' ? { submittedAt: new Date() } : {}),
          ...(reviewed
            ? {
                reviewedById: actor.id,
                reviewedAt: new Date(),
                reviewNote: reason?.trim() || null,
              }
            : {}),
        },
      });
      if (count !== 1) throw this.refusal('state', operator, action);
      const result = await tx.operator.findUniqueOrThrow({
        where: { id: operatorId },
      });
      await this.audit.record(
        {
          action: AUDIT_ACTION[action],
          entityType: 'Operator',
          entityId: operatorId,
          before: { status: operator.status },
          after: { status: next.to },
          reason: reason?.trim() || undefined,
        },
        tx,
      );
      return result;
    });

    await this.notifyAdministrators(updated, action, reason);
    return updated;
  }

  private refusal(
    refused: 'role' | 'state' | 'reason',
    operator: OperatorRecord,
    action: OperatorAction,
  ): AppException {
    if (refused === 'role') {
      return new AppException(
        'FORBIDDEN',
        'You do not have access to this.',
        HttpStatus.FORBIDDEN,
      );
    }
    if (refused === 'reason') {
      return new AppException(
        'VALIDATION_ERROR',
        'A reason is required.',
        HttpStatus.BAD_REQUEST,
        [{ field: 'reason', issue: 'is required' }],
      );
    }
    return new AppException(
      'OPERATOR_INVALID_TRANSITION',
      `An operator that is ${operator.status} cannot be moved by "${action}".`,
      HttpStatus.CONFLICT,
    );
  }

  private async notifyAdministrators(
    operator: OperatorRecord,
    action: OperatorAction,
    reason?: string,
  ): Promise<void> {
    const members = await this.prisma.operatorMember.findMany({
      where: { operatorId: operator.id },
      select: { userId: true },
    });
    const variables = {
      operatorName: operator.tradingName ?? operator.legalName,
      reason: reason?.trim() ?? '',
    };
    for (const { userId } of members) {
      const account = await this.users.findAccount(userId);
      if (account?.role !== Role.OPERATOR_ADMIN) continue;
      await this.notifications.send({
        userId,
        channel: 'IN_APP',
        templateKey: NOTIFICATION[action],
        variables,
      });
      // A submission is confirmed in the app only; decisions are emailed too.
      if (action !== 'submit' && account.email) {
        await this.notifications.send({
          userId,
          channel: 'EMAIL',
          templateKey: NOTIFICATION[action],
          to: account.email,
          variables,
        });
      }
    }
  }

  // --- Administration -----------------------------------------------------

  async list(filter: {
    page: number;
    pageSize: number;
    status?: OperatorStatus;
    q?: string;
  }): Promise<Paginated<OperatorRecord>> {
    const q = filter.q?.trim();
    const where: Prisma.OperatorWhereInput = {
      status: filter.status,
      ...(q
        ? {
            OR: [
              { legalName: { contains: q, mode: 'insensitive' } },
              { tradingName: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.operator.findMany({
        where,
        // Applications waiting longest come first within a status.
        orderBy: [
          { submittedAt: { sort: 'asc', nulls: 'last' } },
          { createdAt: 'desc' },
          { id: 'asc' },
        ],
        skip: (filter.page - 1) * filter.pageSize,
        take: filter.pageSize,
      }),
      this.prisma.operator.count({ where }),
    ]);
    return new Paginated(items, filter.page, filter.pageSize, total);
  }

  async getById(id: string): Promise<OperatorRecord> {
    const operator = await this.prisma.operator.findUnique({ where: { id } });
    if (!operator) throw notFound();
    return operator;
  }

  /** Records the reviewer's decision on one compliance document. */
  async verifyDocument(
    documentId: string,
    actor: AuthUser,
    decision: DocumentVerificationStatus,
    reason?: string,
  ): Promise<OperatorDocumentRecord> {
    const row = await this.prisma.$transaction(async (tx) => {
      const document = await tx.operatorDocument.findUnique({
        where: { id: documentId },
      });
      if (!document) throw notFound('Document');
      const updated = await tx.operatorDocument.update({
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
              ? 'operator_document.verify'
              : 'operator_document.reject',
          entityType: 'OperatorDocument',
          entityId: documentId,
          before: { verificationStatus: document.verificationStatus },
          after: { verificationStatus: decision },
          reason: reason?.trim() || undefined,
        },
        tx,
      );
      return updated;
    });
    const files = await this.documents.describe([row.fileId]);
    return { ...row, fileName: files.get(row.fileId)?.fileName ?? 'document' };
  }
}

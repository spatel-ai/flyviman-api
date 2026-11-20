import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception.js';
import type {
  AirAmbulanceRequest,
  Prisma,
} from '../../generated/prisma/client.js';
import {
  AirAmbulanceStatus,
  OperatorStatus,
  Role,
  UserStatus,
} from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AircraftService } from '../aircraft/aircraft.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OperatorsService } from '../operators/operators.service.js';
import { UsersService } from '../users/users.service.js';
import {
  actorKindFor,
  checkTransition,
  CLOSED,
  type FeasibilityChecklist,
  missingFeasibility,
  parseChecklist,
  statusTimestamps,
} from './air-ambulance-transitions.js';
import {
  type AirAmbulanceActor,
  type AirAmbulanceRequestView,
  notFound,
  toView,
} from './air-ambulance.service.js';

type Tx = Prisma.TransactionClient;

/** The statuses operations move a request to through `PATCH …/status`. */
export const OPERATIONS_TARGETS = [
  AirAmbulanceStatus.SOURCING,
  AirAmbulanceStatus.FEASIBILITY_CHECK,
  AirAmbulanceStatus.CONFIRMED,
  AirAmbulanceStatus.COMPLETED,
  AirAmbulanceStatus.DECLINED,
  AirAmbulanceStatus.CANCELLED,
] as const;
export type OperationsTarget = (typeof OPERATIONS_TARGETS)[number];

/** Where the feasibility checklist may be recorded. */
const FEASIBILITY_STATUSES: ReadonlySet<AirAmbulanceStatus> = new Set([
  AirAmbulanceStatus.FEASIBILITY_CHECK,
  AirAmbulanceStatus.QUOTED,
  AirAmbulanceStatus.ACCEPTED,
]);

export interface QuoteInput {
  operatorId: string;
  amountMinor: number;
  currency: string;
  conditions: string;
}

function conflict(code: string, message: string): AppException {
  return new AppException(code, message, HttpStatus.CONFLICT);
}

function invalidTransition(reason: string): AppException {
  return new AppException(
    'AIR_AMBULANCE_INVALID_TRANSITION',
    `This request cannot make that move: ${reason}.`,
    HttpStatus.CONFLICT,
  );
}

/**
 * The air ambulance workflow (W4-5): assignment, the status machine, the
 * feasibility checklist, the quotation and the customer's answer. Every
 * change locks the request row, is conditional on the status read, writes a
 * timeline entry and an audit record in the same transaction (rule 6), and
 * never carries medical or contact data (rule 8). Nothing here confirms a
 * request on its own: only operations do, with the checklist complete
 * (rule 7).
 */
@Injectable()
export class AirAmbulanceWorkflowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly operators: OperatorsService,
    private readonly users: UsersService,
    private readonly aircraft: AircraftService,
  ) {}

  // --- Operations --------------------------------------------------------

  /**
   * Gives the request an operations owner (the caller when `assigneeId` is
   * left out). The first assignment moves SUBMITTED to ASSIGNED. An
   * operations user may take an unassigned request or hand on their own; a
   * super administrator may reassign any. The owner reads the medical
   * details, so every change of owner is audited.
   */
  async assign(
    actor: AirAmbulanceActor,
    reference: string,
    assigneeId: string = actor.id,
  ): Promise<AirAmbulanceRequestView> {
    return this.prisma.$transaction(async (tx) => {
      const row = await this.lock(tx, reference);
      if (CLOSED.has(row.status)) {
        throw conflict('AIR_AMBULANCE_CLOSED', 'This request is closed.');
      }
      if (
        actor.role === Role.OPS &&
        row.assignedToId !== null &&
        row.assignedToId !== actor.id
      ) {
        throw notOwner();
      }
      const assignee = await this.users.findAccount(assigneeId);
      if (
        !assignee ||
        assignee.status !== UserStatus.ACTIVE ||
        (assignee.role !== Role.OPS && assignee.role !== Role.SUPER_ADMIN)
      ) {
        throw new AppException(
          'AIR_AMBULANCE_ASSIGNEE_INVALID',
          'The owner must be an active operations user or super administrator.',
          HttpStatus.UNPROCESSABLE_ENTITY,
          [{ field: 'assigneeId', issue: 'not an active operations user' }],
        );
      }
      if (row.assignedToId === assigneeId) return toView(row);

      if (row.status === AirAmbulanceStatus.SUBMITTED) {
        return this.apply(tx, row, AirAmbulanceStatus.ASSIGNED, actor, {
          data: { assignedToId: assigneeId },
          payload: { kind: 'ASSIGNMENT', assignedToId: assigneeId },
          audit: { assignedToId: assigneeId },
          auditBefore: { assignedToId: row.assignedToId },
        });
      }
      return this.record(tx, row, actor, {
        data: { assignedToId: assigneeId },
        payload: { kind: 'ASSIGNMENT', assignedToId: assigneeId },
        action: 'air_ambulance_request.assign',
        before: { assignedToId: row.assignedToId },
        after: { assignedToId: assigneeId },
      });
    });
  }

  /**
   * Moves the request along the workflow (`OPERATIONS_TARGETS`). CONFIRMED
   * needs ACCEPTED, the whole feasibility checklist (422
   * `AIR_AMBULANCE_FEASIBILITY_INCOMPLETE`) and the selected operator still
   * approved (409 `OPERATOR_NOT_APPROVED`, rules 3 and 4).
   */
  async move(
    actor: AirAmbulanceActor,
    reference: string,
    to: OperationsTarget,
  ): Promise<AirAmbulanceRequestView> {
    return this.prisma.$transaction(async (tx) => {
      const row = await this.lock(tx, reference);
      this.assertOwner(row, actor);
      if (
        to === AirAmbulanceStatus.CONFIRMED &&
        row.status === AirAmbulanceStatus.ACCEPTED
      ) {
        const missing = missingFeasibility(
          parseChecklist({ checklist: row.feasibility }),
        );
        if (missing.length > 0) {
          throw new AppException(
            'AIR_AMBULANCE_FEASIBILITY_INCOMPLETE',
            'Every feasibility check must be recorded before confirming.',
            HttpStatus.UNPROCESSABLE_ENTITY,
            missing.map((item) => ({ field: item, issue: 'not checked' })),
          );
        }
        await this.assertApproved(tx, row.selectedOperatorId);
        await this.assertEligible(tx, row.selectedOperatorId);
      }
      return this.apply(tx, row, to, actor);
    });
  }

  /**
   * Records the feasibility checklist as it stands, while the request is
   * between FEASIBILITY_CHECK and ACCEPTED. Each recording is a timeline
   * entry carrying the whole checklist (booleans only).
   */
  async recordFeasibility(
    actor: AirAmbulanceActor,
    reference: string,
    checklist: FeasibilityChecklist,
  ): Promise<AirAmbulanceRequestView> {
    return this.prisma.$transaction(async (tx) => {
      const row = await this.lock(tx, reference);
      this.assertOwner(row, actor);
      if (!FEASIBILITY_STATUSES.has(row.status)) {
        throw invalidTransition(
          `the feasibility checklist cannot be recorded while ${row.status}`,
        );
      }
      return this.record(tx, row, actor, {
        data: { feasibility: checklist },
        payload: { kind: 'FEASIBILITY', checklist },
        action: 'air_ambulance_request.feasibility',
        before: { checklist: parseChecklist({ checklist: row.feasibility }) },
        after: { checklist },
      });
    });
  }

  /**
   * Sends the customer a quotation (priceType QUOTE, rule 1) from an
   * approved operator (rule 4), moving FEASIBILITY_CHECK to QUOTED. While
   * QUOTED, a new quotation replaces the last one.
   */
  async quote(
    actor: AirAmbulanceActor,
    reference: string,
    input: QuoteInput,
  ): Promise<AirAmbulanceRequestView> {
    return this.prisma.$transaction(async (tx) => {
      const row = await this.lock(tx, reference);
      this.assertOwner(row, actor);
      if (
        row.status !== AirAmbulanceStatus.FEASIBILITY_CHECK &&
        row.status !== AirAmbulanceStatus.QUOTED
      ) {
        throw invalidTransition(`a ${row.status} request cannot be quoted`);
      }
      await this.assertApproved(tx, input.operatorId);
      await this.assertEligible(tx, input.operatorId);
      const data = {
        selectedOperatorId: input.operatorId,
        quoteAmountMinor: input.amountMinor,
        quoteCurrency: input.currency,
        quoteConditions: input.conditions,
        quotedAt: new Date(),
      };
      const quote = {
        operatorId: input.operatorId,
        amountMinor: input.amountMinor,
        currency: input.currency,
      };
      const before = {
        operatorId: row.selectedOperatorId,
        amountMinor: row.quoteAmountMinor,
        currency: row.quoteCurrency,
      };
      if (row.status === AirAmbulanceStatus.QUOTED) {
        return this.record(tx, row, actor, {
          data,
          payload: { kind: 'QUOTE', ...quote },
          action: 'air_ambulance_request.quote',
          before,
          after: quote,
        });
      }
      return this.apply(tx, row, AirAmbulanceStatus.QUOTED, actor, {
        data,
        payload: { kind: 'QUOTE', ...quote },
        audit: quote,
        auditBefore: before,
      });
    });
  }

  // --- The customer -------------------------------------------------------

  /**
   * Accepts the quotation the customer saw: 409 `AIR_AMBULANCE_QUOTE_CHANGED`
   * (current amount in `details`) when it differs, 409
   * `AIR_AMBULANCE_QUOTE_UNAVAILABLE` when the operator is no longer
   * approved (rule 3). ACCEPTED is still a request, never a confirmation.
   */
  async accept(
    actor: AirAmbulanceActor,
    reference: string,
    expectedAmountMinor: number,
  ): Promise<AirAmbulanceRequestView> {
    return this.prisma.$transaction(async (tx) => {
      const row = await this.ownLocked(tx, reference, actor);
      if (row.status !== AirAmbulanceStatus.QUOTED) {
        throw invalidTransition(
          `a ${row.status} request has no open quotation`,
        );
      }
      if (row.quoteAmountMinor !== expectedAmountMinor) {
        throw new AppException(
          'AIR_AMBULANCE_QUOTE_CHANGED',
          'The quotation has changed. Review it before accepting.',
          HttpStatus.CONFLICT,
          [
            { field: 'amountMinor', issue: String(row.quoteAmountMinor) },
            { field: 'currency', issue: String(row.quoteCurrency) },
          ],
        );
      }
      const status = row.selectedOperatorId
        ? await this.operators.statusOf(row.selectedOperatorId, tx)
        : null;
      if (status !== OperatorStatus.APPROVED) {
        throw conflict(
          'AIR_AMBULANCE_QUOTE_UNAVAILABLE',
          'This quotation can no longer be accepted. Operations will contact you.',
        );
      }
      return this.apply(tx, row, AirAmbulanceStatus.ACCEPTED, actor, {
        audit: { amountMinor: row.quoteAmountMinor },
      });
    });
  }

  /** Declines the quotation (QUOTED to DECLINED). */
  async decline(
    actor: AirAmbulanceActor,
    reference: string,
  ): Promise<AirAmbulanceRequestView> {
    return this.prisma.$transaction(async (tx) => {
      const row = await this.ownLocked(tx, reference, actor);
      return this.apply(tx, row, AirAmbulanceStatus.DECLINED, actor);
    });
  }

  /** Withdraws the request, from any status before COMPLETED. */
  async cancel(
    actor: AirAmbulanceActor,
    reference: string,
  ): Promise<AirAmbulanceRequestView> {
    return this.prisma.$transaction(async (tx) => {
      const row = await this.ownLocked(tx, reference, actor);
      return this.apply(tx, row, AirAmbulanceStatus.CANCELLED, actor);
    });
  }

  // --- Internals ----------------------------------------------------------

  /** The request, row-locked until the transaction ends; 404 if none. */
  private async lock(tx: Tx, reference: string): Promise<AirAmbulanceRequest> {
    await tx.$queryRaw`SELECT id FROM "AirAmbulanceRequest"
      WHERE reference = ${reference} FOR UPDATE`;
    const row = await tx.airAmbulanceRequest.findUnique({
      where: { reference },
    });
    if (!row) throw notFound();
    return row;
  }

  /** The caller's own request, locked; anyone else's is 404. */
  private async ownLocked(
    tx: Tx,
    reference: string,
    actor: AirAmbulanceActor,
  ): Promise<AirAmbulanceRequest> {
    const row = await this.lock(tx, reference);
    if (row.requesterId !== actor.id) throw notFound();
    return row;
  }

  /** Operations act on a request they own; a super administrator on any. */
  private assertOwner(row: AirAmbulanceRequest, actor: AirAmbulanceActor) {
    if (actor.role === Role.SUPER_ADMIN) return;
    if (row.assignedToId !== actor.id) throw notOwner();
  }

  private async assertApproved(tx: Tx, operatorId: string | null) {
    const status = operatorId
      ? await this.operators.statusOf(operatorId, tx)
      : null;
    if (status !== OperatorStatus.APPROVED) {
      throw conflict(
        'OPERATOR_NOT_APPROVED',
        'The operator is not approved, so it cannot be offered.',
      );
    }
  }

  /**
   * Only an operator with an approved air ambulance aircraft may be quoted
   * or confirmed for a mission (owner decision 2026-11-20, W4-6).
   */
  private async assertEligible(tx: Tx, operatorId: string | null) {
    const eligible =
      operatorId !== null &&
      (await this.aircraft.hasAirAmbulanceAircraft(operatorId, tx));
    if (!eligible) {
      throw conflict(
        'AIR_AMBULANCE_OPERATOR_NOT_ELIGIBLE',
        'This operator has no approved air ambulance aircraft, so it cannot fly this mission.',
      );
    }
  }

  /**
   * The one transition function: checks the table, updates the row only if
   * its status is still the one read, and writes the timeline entry and
   * the audit record (statuses and ids only).
   */
  private async apply(
    tx: Tx,
    row: AirAmbulanceRequest,
    to: AirAmbulanceStatus,
    actor: AirAmbulanceActor,
    extra: {
      data?: Prisma.AirAmbulanceRequestUpdateManyMutationInput & {
        assignedToId?: string;
        selectedOperatorId?: string;
      };
      payload?: Prisma.InputJsonObject;
      audit?: Prisma.InputJsonObject;
      auditBefore?: Prisma.InputJsonObject;
    } = {},
  ): Promise<AirAmbulanceRequestView> {
    const kind = actorKindFor(actor.role);
    if (!kind) throw notFound();
    const check = checkTransition(row.status, to, kind, {
      feasibilityComplete:
        missingFeasibility(parseChecklist({ checklist: row.feasibility }))
          .length === 0,
    });
    if (!check.allowed) throw invalidTransition(check.reason);

    const now = new Date();
    const updated = await tx.airAmbulanceRequest.updateMany({
      where: { id: row.id, status: row.status },
      data: { ...extra.data, status: to, ...statusTimestamps(to, now) },
    });
    if (updated.count !== 1) {
      throw invalidTransition('the request changed meanwhile');
    }
    await tx.airAmbulanceRequestEvent.create({
      data: {
        requestId: row.id,
        fromStatus: row.status,
        toStatus: to,
        actorId: actor.id,
        actorRole: actor.role,
        payload: extra.payload,
        createdAt: now,
      },
    });
    await this.audit.record(
      {
        action: 'air_ambulance_request.transition',
        entityType: 'AirAmbulanceRequest',
        entityId: row.id,
        before: { status: row.status, ...extra.auditBefore },
        after: { status: to, ...extra.audit },
        actor,
      },
      tx,
    );
    return toView(
      await tx.airAmbulanceRequest.findUniqueOrThrow({ where: { id: row.id } }),
    );
  }

  /** A change that keeps the status: a timeline entry and an audit record. */
  private async record(
    tx: Tx,
    row: AirAmbulanceRequest,
    actor: AirAmbulanceActor,
    change: {
      data: Prisma.AirAmbulanceRequestUpdateManyMutationInput & {
        assignedToId?: string;
        selectedOperatorId?: string;
      };
      payload: Prisma.InputJsonObject;
      action: string;
      before: Prisma.InputJsonObject;
      after: Prisma.InputJsonObject;
    },
  ): Promise<AirAmbulanceRequestView> {
    const now = new Date();
    const updated = await tx.airAmbulanceRequest.updateMany({
      where: { id: row.id, status: row.status },
      data: change.data,
    });
    if (updated.count !== 1) {
      throw invalidTransition('the request changed meanwhile');
    }
    await tx.airAmbulanceRequestEvent.create({
      data: {
        requestId: row.id,
        fromStatus: row.status,
        toStatus: row.status,
        actorId: actor.id,
        actorRole: actor.role,
        payload: change.payload,
        createdAt: now,
      },
    });
    await this.audit.record(
      {
        action: change.action,
        entityType: 'AirAmbulanceRequest',
        entityId: row.id,
        before: change.before,
        after: change.after,
        actor,
      },
      tx,
    );
    return toView(
      await tx.airAmbulanceRequest.findUniqueOrThrow({ where: { id: row.id } }),
    );
  }
}

function notOwner(): AppException {
  return new AppException(
    'AIR_AMBULANCE_NOT_OWNER',
    'Only the assigned operations owner or a super administrator can do this.',
    HttpStatus.FORBIDDEN,
  );
}

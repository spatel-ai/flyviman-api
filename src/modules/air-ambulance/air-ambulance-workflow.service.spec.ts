import { describe, expect, it, vi } from 'vitest';
import { Role } from '../../generated/prisma/enums.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { AircraftService } from '../aircraft/aircraft.service.js';
import type { AuditService } from '../audit/audit.service.js';
import type { OperatorsService } from '../operators/operators.service.js';
import type { UsersService } from '../users/users.service.js';
import { FEASIBILITY_ITEMS } from './air-ambulance-transitions.js';
import { AirAmbulanceWorkflowService } from './air-ambulance-workflow.service.js';

const NOW = new Date('2026-11-20T08:00:00.000Z');
const OWNER = { id: 'u-owner', role: Role.OPS };
const OTHER_OPS = { id: 'u-ops-2', role: Role.OPS };
const ADMIN = { id: 'u-sa', role: Role.SUPER_ADMIN };
const CUSTOMER = { id: 'u-customer', role: Role.CUSTOMER };
const ALL_CHECKED = Object.fromEntries(FEASIBILITY_ITEMS.map((i) => [i, true]));

function setup(
  row: Record<string, unknown>,
  operatorStatus = 'APPROVED',
  ambulanceAircraft = true,
) {
  let current: Record<string, unknown> = {
    id: 'aa-1',
    reference: 'FLY-AA-7K2M9Q',
    requesterId: CUSTOMER.id,
    contactName: 'Asha Rao',
    contactPhone: '+919800000000',
    contactEmail: null,
    emergencyContactName: null,
    emergencyContactPhone: null,
    originLocationId: 'loc-1',
    destinationLocationId: 'loc-2',
    pickupAddress: null,
    destinationFacility: null,
    preferredAt: NOW,
    patientCount: 1,
    accompanyingPersons: 0,
    assignedToId: OWNER.id,
    selectedOperatorId: 'op-1',
    quoteAmountMinor: 50_000_000,
    quoteCurrency: 'INR',
    quoteConditions: 'Non-refundable once airborne.',
    quotedAt: NOW,
    feasibility: null,
    confirmedAt: null,
    completedAt: null,
    closedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...row,
  };
  const events: Record<string, unknown>[] = [];
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: current.id }]),
    airAmbulanceRequest: {
      findUnique: vi.fn(async () => current),
      findUniqueOrThrow: vi.fn(async () => current),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { status: string };
          data: Record<string, unknown>;
        }) => {
          if (where.status !== current.status) return { count: 0 };
          current = { ...current, ...data };
          return { count: 1 };
        },
      ),
    },
    airAmbulanceRequestEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        events.push(data);
        return data;
      }),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (run: (client: typeof tx) => unknown) => run(tx)),
  } as unknown as PrismaService;
  const audit = { record: vi.fn(async (): Promise<void> => undefined) };
  const operators = { statusOf: vi.fn(async () => operatorStatus) };
  const users = {
    findAccount: vi.fn(async (id: string) =>
      id === OTHER_OPS.id
        ? { id, role: Role.OPS, status: 'ACTIVE' }
        : id === 'u-finance'
          ? { id, role: Role.FINANCE_ADMIN, status: 'ACTIVE' }
          : null,
    ),
  };
  const service = new AirAmbulanceWorkflowService(
    prisma,
    audit as unknown as AuditService,
    operators as unknown as OperatorsService,
    users as unknown as UsersService,
    {
      hasAirAmbulanceAircraft: vi.fn(async () => ambulanceAircraft),
    } as unknown as AircraftService,
  );
  return { service, events, audit, current: () => current };
}

describe('AirAmbulanceWorkflowService.move to CONFIRMED', () => {
  it('refuses without the whole feasibility checklist and changes nothing', async () => {
    const { service, events, current } = setup({
      status: 'ACCEPTED',
      feasibility: { ...ALL_CHECKED, weather: false },
    });
    await expect(
      service.move(OWNER, 'FLY-AA-7K2M9Q', 'CONFIRMED'),
    ).rejects.toMatchObject({
      code: 'AIR_AMBULANCE_FEASIBILITY_INCOMPLETE',
      details: [{ field: 'weather', issue: 'not checked' }],
    });
    expect(current().status).toBe('ACCEPTED');
    expect(events).toEqual([]);
  });

  it('refuses when the selected operator is no longer approved', async () => {
    const { service } = setup(
      { status: 'ACCEPTED', feasibility: ALL_CHECKED },
      'SUSPENDED',
    );
    await expect(
      service.move(OWNER, 'FLY-AA-7K2M9Q', 'CONFIRMED'),
    ).rejects.toMatchObject({ code: 'OPERATOR_NOT_APPROVED' });
  });

  it('refuses an operator that no longer has an approved air ambulance aircraft', async () => {
    const { service, current } = setup(
      { status: 'ACCEPTED', feasibility: ALL_CHECKED },
      'APPROVED',
      false,
    );
    await expect(
      service.move(OWNER, 'FLY-AA-7K2M9Q', 'CONFIRMED'),
    ).rejects.toMatchObject({ code: 'AIR_AMBULANCE_OPERATOR_NOT_ELIGIBLE' });
    expect(current().status).toBe('ACCEPTED');
  });

  it('refuses operations staff who do not own the request', async () => {
    const { service } = setup({ status: 'ACCEPTED', feasibility: ALL_CHECKED });
    await expect(
      service.move(OTHER_OPS, 'FLY-AA-7K2M9Q', 'CONFIRMED'),
    ).rejects.toMatchObject({ code: 'AIR_AMBULANCE_NOT_OWNER' });
  });

  it('confirms for the owner: confirmedAt, a timeline entry by OPS and a status-only audit', async () => {
    const { service, events, audit, current } = setup({
      status: 'ACCEPTED',
      feasibility: ALL_CHECKED,
    });
    const view = await service.move(OWNER, 'FLY-AA-7K2M9Q', 'CONFIRMED');
    expect(view.status).toBe('CONFIRMED');
    expect(current().confirmedAt).toBeInstanceOf(Date);
    expect(events).toMatchObject([
      {
        fromStatus: 'ACCEPTED',
        toStatus: 'CONFIRMED',
        actorId: OWNER.id,
        actorRole: 'OPS',
      },
    ]);
    const entry = (audit.record.mock.calls[0] as unknown[])[0];
    expect(entry).toMatchObject({
      action: 'air_ambulance_request.transition',
      before: { status: 'ACCEPTED' },
      after: { status: 'CONFIRMED' },
    });
    expect(JSON.stringify(entry)).not.toMatch(/Asha|\+91/);
  });

  it('lets a super administrator confirm a request owned by someone else', async () => {
    const { service } = setup({ status: 'ACCEPTED', feasibility: ALL_CHECKED });
    expect(
      (await service.move(ADMIN, 'FLY-AA-7K2M9Q', 'CONFIRMED')).status,
    ).toBe('CONFIRMED');
  });
});

describe('AirAmbulanceWorkflowService.quote', () => {
  const QUOTE = {
    operatorId: 'op-2',
    amountMinor: 40_000_000,
    currency: 'INR',
    conditions: 'Free cancellation until dispatch.',
  };

  it('refuses an approved operator without an approved air ambulance aircraft', async () => {
    const { service, events, current } = setup(
      { status: 'FEASIBILITY_CHECK' },
      'APPROVED',
      false,
    );
    await expect(
      service.quote(OWNER, 'FLY-AA-7K2M9Q', QUOTE),
    ).rejects.toMatchObject({ code: 'AIR_AMBULANCE_OPERATOR_NOT_ELIGIBLE' });
    expect(current().status).toBe('FEASIBILITY_CHECK');
    expect(events).toEqual([]);
  });

  it('quotes an eligible operator', async () => {
    const { service } = setup({ status: 'FEASIBILITY_CHECK' });
    const view = await service.quote(OWNER, 'FLY-AA-7K2M9Q', QUOTE);
    expect(view).toMatchObject({
      status: 'QUOTED',
      selectedOperatorId: 'op-2',
    });
  });
});

describe('AirAmbulanceWorkflowService: the customer', () => {
  it('cannot accept a changed quotation', async () => {
    const { service } = setup({ status: 'QUOTED' });
    await expect(
      service.accept(CUSTOMER, 'FLY-AA-7K2M9Q', 1),
    ).rejects.toMatchObject({ code: 'AIR_AMBULANCE_QUOTE_CHANGED' });
  });

  it('accepting moves to ACCEPTED, never CONFIRMED', async () => {
    const { service } = setup({ status: 'QUOTED' });
    const view = await service.accept(CUSTOMER, 'FLY-AA-7K2M9Q', 50_000_000);
    expect(view.status).toBe('ACCEPTED');
    expect(view.confirmedAt).toBeNull();
  });

  it('another customer’s request is not found', async () => {
    const { service } = setup({ status: 'QUOTED' });
    await expect(
      service.cancel({ id: 'u-other', role: Role.CUSTOMER }, 'FLY-AA-7K2M9Q'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('AirAmbulanceWorkflowService.assign', () => {
  it('moves SUBMITTED to ASSIGNED for the caller', async () => {
    const { service, events } = setup({
      status: 'SUBMITTED',
      assignedToId: null,
      selectedOperatorId: null,
      quoteAmountMinor: null,
      quoteCurrency: null,
      quotedAt: null,
    });
    const view = await service.assign(OTHER_OPS, 'FLY-AA-7K2M9Q');
    expect(view).toMatchObject({
      status: 'ASSIGNED',
      assignedToId: OTHER_OPS.id,
    });
    expect(events[0]).toMatchObject({ payload: { kind: 'ASSIGNMENT' } });
  });

  it('refuses an owner who is not operations', async () => {
    const { service } = setup({ status: 'SUBMITTED', assignedToId: null });
    await expect(
      service.assign(ADMIN, 'FLY-AA-7K2M9Q', 'u-finance'),
    ).rejects.toMatchObject({ code: 'AIR_AMBULANCE_ASSIGNEE_INVALID' });
  });

  it('refuses operations taking a request someone else owns', async () => {
    const { service } = setup({ status: 'SOURCING' });
    await expect(
      service.assign(OTHER_OPS, 'FLY-AA-7K2M9Q'),
    ).rejects.toMatchObject({ code: 'AIR_AMBULANCE_NOT_OWNER' });
  });
});

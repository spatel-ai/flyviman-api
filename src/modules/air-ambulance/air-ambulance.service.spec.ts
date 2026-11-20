import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { FieldCipher, isEncrypted } from '../../common/crypto/field-cipher.js';
import { AIR_AMBULANCE_REFERENCE } from '../../common/reference.js';
import {
  AirAmbulanceStatus,
  PatientMobility,
  Role,
} from '../../generated/prisma/enums.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { AuditService } from '../audit/audit.service.js';
import type { DocumentsService } from '../documents/documents.service.js';
import type { LocationsService } from '../locations/locations.service.js';
import type { OperatorsService } from '../operators/operators.service.js';
import {
  type AirAmbulanceActor,
  AirAmbulanceService,
  type CreateAirAmbulanceRequestInput,
  readAccess,
} from './air-ambulance.service.js';

const NOW = new Date('2026-11-20T08:00:00.000Z');
const CLAIM = { id: 'k-1', ownerToken: 'owner-1' };
const CONDITION = 'Post-operative cardiac patient, stable on monitoring';

const REQUESTER = 'u-requester';
const OPS_OWNER = 'u-ops-owner';
const OPERATOR_ID = 'op-selected';

const cipher = new FieldCipher({
  getOrThrow: () => Buffer.alloc(32, 7).toString('base64'),
} as unknown as ConfigService);

function input(
  medical: Partial<CreateAirAmbulanceRequestInput['medical']> = {},
): CreateAirAmbulanceRequestInput {
  return {
    contactName: 'Asha Rao',
    contactPhone: '+919800000000',
    originLocationId: 'loc-1',
    destinationLocationId: 'loc-2',
    preferredAt: NOW,
    patientCount: 1,
    accompanyingPersons: 1,
    medical: {
      patientCondition: CONDITION,
      mobility: PatientMobility.NON_AMBULATORY,
      stretcherRequired: true,
      oxygenRequired: true,
      medicalStaffRequired: 'ICU doctor and nurse',
      ...medical,
    },
  };
}

function setup(
  options: {
    status?: AirAmbulanceStatus;
    memberOf?: Record<string, string>;
    activeLocations?: string[];
    suspended?: string[];
  } = {},
) {
  const stored: {
    request?: Record<string, unknown>;
    medical?: Record<string, unknown>;
  } = {};
  const events: Record<string, unknown>[] = [];
  const tx = {
    idempotencyKey: { updateMany: vi.fn(async () => ({ count: 1 })) },
    airAmbulanceRequest: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const { medical, ...request } = data as {
          medical: { create: Record<string, unknown> };
        } & Record<string, unknown>;
        stored.request = {
          id: 'aa-1',
          contactEmail: null,
          emergencyContactName: null,
          emergencyContactPhone: null,
          pickupAddress: null,
          destinationFacility: null,
          assignedToId: OPS_OWNER,
          selectedOperatorId: OPERATOR_ID,
          confirmedAt: null,
          completedAt: null,
          closedAt: null,
          createdAt: NOW,
          updatedAt: NOW,
          ...request,
        };
        stored.medical = { id: 'm-1', requestId: 'aa-1', ...medical.create };
        return stored.request;
      }),
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
    airAmbulanceRequest: {
      findUnique: vi.fn(async () =>
        stored.request
          ? { ...stored.request, status: options.status ?? 'SUBMITTED' }
          : null,
      ),
    },
    airAmbulanceMedical: {
      findUnique: vi.fn(async () =>
        stored.medical
          ? { ...stored.medical, request: { documents: [{ fileId: 'f-1' }] } }
          : null,
      ),
    },
  } as unknown as PrismaService;
  const audit = { record: vi.fn(async (): Promise<void> => undefined) };
  const memberOf = options.memberOf ?? {};
  const suspended = options.suspended ?? [];
  const active = options.activeLocations ?? ['loc-1', 'loc-2'];
  const locations = {
    isActive: vi.fn(async (id: string) => active.includes(id)),
  };
  const operators = {
    forMember: vi.fn(async (userId: string) => {
      const id = memberOf[userId];
      if (!id) throw new Error('not a member');
      return { id, status: suspended.includes(id) ? 'SUSPENDED' : 'APPROVED' };
    }),
  };
  const service = new AirAmbulanceService(
    prisma,
    audit as unknown as AuditService,
    cipher,
    operators as unknown as OperatorsService,
    locations as unknown as LocationsService,
    {} as DocumentsService,
  );
  return { service, stored, events, audit, tx, locations };
}

const customer: AirAmbulanceActor = { id: REQUESTER, role: Role.CUSTOMER };

describe('AirAmbulanceService.create', () => {
  it('stores the free-text medical fields encrypted and the structured ones plain', async () => {
    const { service, stored } = setup();
    await service.create(
      customer,
      input({ notes: 'Allergic to penicillin' }),
      CLAIM,
    );
    const medical = stored.medical!;
    for (const field of ['patientCondition', 'medicalStaffRequired', 'notes']) {
      expect(isEncrypted(medical[field] as string), field).toBe(true);
    }
    expect(JSON.stringify(medical)).not.toContain('cardiac');
    expect(JSON.stringify(medical)).not.toContain('penicillin');
    expect(medical.equipmentRequired).toBeNull();
    expect(medical.specialisedCare).toBeNull();
    expect(medical).toMatchObject({
      mobility: 'NON_AMBULATORY',
      stretcherRequired: true,
      oxygenRequired: true,
    });
  });

  it('records a SUBMITTED request for the caller, its first timeline entry and a status-only audit', async () => {
    const { service, stored, events, audit, tx } = setup();
    const view = await service.create(customer, input(), CLAIM);
    expect(view.reference).toMatch(AIR_AMBULANCE_REFERENCE);
    expect(view.status).toBe('SUBMITTED');
    expect(view).not.toHaveProperty('medical');
    expect(stored.request).toMatchObject({
      requesterId: REQUESTER,
      status: 'SUBMITTED',
    });
    expect(events).toEqual([
      {
        requestId: 'aa-1',
        fromStatus: null,
        toStatus: 'SUBMITTED',
        actorId: REQUESTER,
        actorRole: 'CUSTOMER',
      },
    ]);
    expect(tx.idempotencyKey.updateMany).toHaveBeenCalledOnce();
    expect(audit.record).toHaveBeenCalledWith(
      {
        action: 'air_ambulance_request.create',
        entityType: 'AirAmbulanceRequest',
        entityId: 'aa-1',
        after: { status: 'SUBMITTED' },
        actor: customer,
      },
      tx,
    );
  });
});

describe('AirAmbulanceService.create: locations', () => {
  it('refuses the same place at both ends with 400 and stores nothing', async () => {
    const { service, stored } = setup();
    await expect(
      service.create(
        customer,
        { ...input(), destinationLocationId: 'loc-1' },
        CLAIM,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });
    expect(stored.request).toBeUndefined();
  });

  it('answers 404 for an unknown or inactive location, never a foreign-key error', async () => {
    const { service, stored } = setup({ activeLocations: ['loc-1'] });
    await expect(
      service.create(customer, input(), CLAIM),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    expect(stored.request).toBeUndefined();
  });
});

describe('readAccess', () => {
  const row = {
    requesterId: REQUESTER,
    assignedToId: OPS_OWNER,
    selectedOperatorId: OPERATOR_ID,
    status: AirAmbulanceStatus.ACCEPTED,
  };
  const cases: [
    string,
    AirAmbulanceActor,
    string | null,
    AirAmbulanceStatus,
    { request: boolean; medical: boolean },
  ][] = [
    [
      'the requester',
      customer,
      null,
      'SUBMITTED',
      { request: true, medical: true },
    ],
    [
      'another customer',
      { id: 'u-other', role: Role.CUSTOMER },
      null,
      'ACCEPTED',
      { request: false, medical: false },
    ],
    [
      'the assigned operations owner',
      { id: OPS_OWNER, role: Role.OPS },
      null,
      'SUBMITTED',
      { request: true, medical: true },
    ],
    [
      'other operations staff',
      { id: 'u-ops-2', role: Role.OPS },
      null,
      'ACCEPTED',
      { request: true, medical: false },
    ],
    [
      'the super administrator',
      { id: 'u-sa', role: Role.SUPER_ADMIN },
      null,
      'SUBMITTED',
      { request: true, medical: true },
    ],
    [
      'finance',
      { id: 'u-fin', role: Role.FINANCE_ADMIN },
      null,
      'ACCEPTED',
      { request: false, medical: false },
    ],
    [
      'the selected operator, after acceptance',
      { id: 'u-oa', role: Role.OPERATOR_ADMIN },
      OPERATOR_ID,
      'ACCEPTED',
      { request: true, medical: true },
    ],
    [
      'the selected operator, once confirmed',
      { id: 'u-oa', role: Role.OPERATOR_ADMIN },
      OPERATOR_ID,
      'CONFIRMED',
      { request: true, medical: true },
    ],
    [
      'the selected operator, before acceptance',
      { id: 'u-oa', role: Role.OPERATOR_ADMIN },
      OPERATOR_ID,
      'QUOTED',
      { request: false, medical: false },
    ],
    [
      'the selected operator, after cancellation',
      { id: 'u-oa', role: Role.OPERATOR_ADMIN },
      OPERATOR_ID,
      'CANCELLED',
      { request: false, medical: false },
    ],
    [
      'another operator',
      { id: 'u-oa-2', role: Role.OPERATOR_ADMIN },
      'op-other',
      'ACCEPTED',
      { request: false, medical: false },
    ],
    [
      'an operator administrator with no organisation',
      { id: 'u-oa-3', role: Role.OPERATOR_ADMIN },
      null,
      'ACCEPTED',
      { request: false, medical: false },
    ],
    [
      'staff of the selected operator',
      { id: 'u-os', role: Role.OPERATOR_STAFF },
      OPERATOR_ID,
      'ACCEPTED',
      { request: false, medical: false },
    ],
  ];
  it.each(cases)('%s', (_name, actor, operatorId, status, expected) => {
    expect(readAccess({ ...row, status }, actor, operatorId)).toEqual(expected);
  });

  it('gives no medical access to an unassigned request', () => {
    expect(
      readAccess(
        { ...row, assignedToId: null },
        { id: OPS_OWNER, role: Role.OPS },
        null,
      ),
    ).toEqual({ request: true, medical: false });
  });
});

describe('AirAmbulanceService.findOne', () => {
  async function created(options: Parameters<typeof setup>[0] = {}) {
    const ctx = setup(options);
    await ctx.service.create(customer, input(), CLAIM);
    ctx.audit.record.mockClear();
    return ctx;
  }

  it('decrypts the medical details for the requester and audits the read without medical data', async () => {
    const { service, audit } = await created();
    const detail = await service.findOne('aa-1', customer);
    expect(detail.medical).toEqual({
      patientCondition: CONDITION,
      mobility: 'NON_AMBULATORY',
      stretcherRequired: true,
      oxygenRequired: true,
      medicalStaffRequired: 'ICU doctor and nurse',
      equipmentRequired: null,
      specialisedCare: null,
      notes: null,
      documentFileIds: ['f-1'],
    });
    expect(audit.record).toHaveBeenCalledExactlyOnceWith({
      action: 'air_ambulance_request.medical_read',
      entityType: 'AirAmbulanceRequest',
      entityId: 'aa-1',
      actor: customer,
    });
  });

  it('audits every read, the super administrator included', async () => {
    const { service, audit } = await created();
    const admin = { id: 'u-sa', role: Role.SUPER_ADMIN };
    await service.findOne('aa-1', admin);
    await service.findOne('aa-1', admin);
    expect(audit.record).toHaveBeenCalledTimes(2);
  });

  it('returns the request without medical details, and writes no audit, to unassigned operations', async () => {
    const { service, audit } = await created();
    const detail = await service.findOne('aa-1', {
      id: 'u-ops-2',
      role: Role.OPS,
    });
    expect(detail.reference).toMatch(AIR_AMBULANCE_REFERENCE);
    expect(detail.medical).toBeNull();
    expect(JSON.stringify(detail)).not.toContain('cardiac');
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('answers 404 to finance, another customer and operator staff', async () => {
    const { service, audit } = await created({ status: 'ACCEPTED' });
    for (const actor of [
      { id: 'u-fin', role: Role.FINANCE_ADMIN },
      { id: 'u-other', role: Role.CUSTOMER },
      { id: 'u-os', role: Role.OPERATOR_STAFF },
    ]) {
      await expect(service.findOne('aa-1', actor)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    }
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('opens the medical details to the selected operator only after acceptance', async () => {
    const memberOf = { 'u-oa': OPERATOR_ID };
    const oa = { id: 'u-oa', role: Role.OPERATOR_ADMIN };
    const before = await created({ status: 'QUOTED', memberOf });
    await expect(before.service.findOne('aa-1', oa)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const after = await created({ status: 'ACCEPTED', memberOf });
    const detail = await after.service.findOne('aa-1', oa);
    expect(detail.medical?.patientCondition).toBe(CONDITION);
    expect(after.audit.record).toHaveBeenCalledOnce();
  });

  it('closes the request to a suspended operator’s administrators', async () => {
    const oa = { id: 'u-oa', role: Role.OPERATOR_ADMIN };
    const { service } = await created({
      status: 'ACCEPTED',
      memberOf: { 'u-oa': OPERATOR_ID },
      suspended: [OPERATOR_ID],
    });
    await expect(service.findOne('aa-1', oa)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('stores the collection and receiving places encrypted and returns them only with the medical details', async () => {
    const { service, stored } = setup();
    await service.create(
      customer,
      {
        ...input(),
        pickupAddress: 'City Cardiac Centre',
        destinationFacility: 'Apollo Hospital',
      },
      CLAIM,
    );
    expect(isEncrypted(stored.request!.pickupAddress as string)).toBe(true);
    expect(isEncrypted(stored.request!.destinationFacility as string)).toBe(
      true,
    );
    const own = await service.findOne('aa-1', customer);
    expect(own).toMatchObject({
      pickupAddress: 'City Cardiac Centre',
      destinationFacility: 'Apollo Hospital',
    });
    const unassigned = await service.findOne('aa-1', {
      id: 'u-ops-2',
      role: Role.OPS,
    });
    expect(unassigned).toMatchObject({
      pickupAddress: null,
      destinationFacility: null,
      medical: null,
    });
  });

  it('returns nothing medical when the read cannot be audited', async () => {
    const { service, audit } = await created();
    audit.record.mockRejectedValueOnce(new Error('audit down'));
    await expect(service.findOne('aa-1', customer)).rejects.toThrow(
      'audit down',
    );
  });

  it('answers 404 for a request that does not exist', async () => {
    const { service } = setup();
    await expect(service.findOne('missing', customer)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

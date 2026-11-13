import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { AuditService } from '../audit/audit.service.js';
import type { NotificationsService } from '../notifications/notifications.service.js';
import type { CreateEnquiryDto } from './dto/enquiry.dto.js';
import { EnquiriesService } from './enquiries.service.js';
import {
  ENQUIRY_REFERENCE,
  REFERENCE_ALPHABET,
  enquiryReference,
} from './enquiry-reference.js';

const CREATED_AT = new Date('2026-11-13T09:30:00.000Z');

function setup(options: { clashes?: number } = {}) {
  let clashes = options.clashes ?? 0;
  const created: Record<string, unknown>[] = [];
  const tx = {
    enquiry: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (clashes > 0) {
          clashes -= 1;
          throw Object.assign(new Error('unique'), { code: 'P2002' });
        }
        created.push(data);
        return { id: 'e-1', createdAt: CREATED_AT, handledAt: null, ...data };
      }),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (run: (client: typeof tx) => unknown) => run(tx)),
  } as unknown as PrismaService;
  const audit = { record: vi.fn(async () => undefined) };
  const notifications = {
    enqueue: vi.fn(async () => 'n-1'),
    deliver: vi.fn(async () => undefined),
  };
  const config = {
    getOrThrow: vi.fn(() => 'ops-inbox@example.com'),
  } as unknown as ConfigService;
  const service = new EnquiriesService(
    prisma,
    audit as unknown as AuditService,
    notifications as unknown as NotificationsService,
    config,
  );
  return { service, tx, audit, notifications, created };
}

const enquiry = (
  overrides: Partial<CreateEnquiryDto> = {},
): CreateEnquiryDto => ({
  name: 'Asha Rao',
  email: 'asha@example.com',
  topic: 'PRIVATE_CHARTER',
  message: 'Six of us to Goa in December.',
  ...overrides,
});

describe('enquiryReference', () => {
  it('is FLY-ENQ- and six unambiguous characters', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(enquiryReference()).toMatch(ENQUIRY_REFERENCE);
    }
    expect(REFERENCE_ALPHABET).not.toMatch(/[01OIL]/);
  });

  it('draws each character from the alphabet', () => {
    expect(enquiryReference(() => 0)).toBe('FLY-ENQ-222222');
    expect(enquiryReference((max) => max - 1)).toBe('FLY-ENQ-ZZZZZZ');
  });
});

describe('EnquiriesService.create', () => {
  it('needs an email address or a phone number', async () => {
    const { service, tx } = setup();
    await expect(
      service.create(enquiry({ email: undefined, phone: undefined })),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: [{ field: 'email', issue: expect.any(String) }],
    });
    expect(tx.enquiry.create).not.toHaveBeenCalled();
  });

  it('accepts a phone number alone', async () => {
    const { service, created } = setup();
    await service.create(enquiry({ email: undefined, phone: '+919876543210' }));
    expect(created[0]).toMatchObject({ email: null, phone: '+919876543210' });
  });

  it('answers with the reference and time only', async () => {
    const { service } = setup();
    const result = await service.create(enquiry());
    expect(result).toEqual({
      reference: expect.stringMatching(ENQUIRY_REFERENCE),
      receivedAt: '2026-11-13T09:30:00.000Z',
    });
  });

  it('audits the id and topic only, and queues one email to operations', async () => {
    const { service, audit, notifications, tx } = setup();
    await service.create(enquiry());
    expect(audit.record).toHaveBeenCalledWith(
      {
        action: 'enquiry.create',
        entityType: 'Enquiry',
        entityId: 'e-1',
        after: { topic: 'PRIVATE_CHARTER' },
      },
      tx,
    );
    expect(notifications.enqueue).toHaveBeenCalledTimes(1);
    expect(notifications.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'EMAIL',
        to: 'ops-inbox@example.com',
        templateKey: 'enquiry.received',
      }),
      tx,
    );
    expect(notifications.deliver).toHaveBeenCalledWith('n-1');
  });

  it('draws a new reference when one is already taken', async () => {
    const { service, tx } = setup({ clashes: 2 });
    await service.create(enquiry());
    expect(tx.enquiry.create).toHaveBeenCalledTimes(3);
  });

  it('gives up after repeated clashes', async () => {
    const { service } = setup({ clashes: 10 });
    await expect(service.create(enquiry())).rejects.toMatchObject({
      code: 'P2002',
    });
  });
});

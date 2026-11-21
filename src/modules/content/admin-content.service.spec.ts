import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { AuditService } from '../audit/audit.service.js';
import { AdminContentService } from './admin-content.service.js';

// Validation runs before the database is touched.
const service = new AdminContentService(
  {} as PrismaService,
  {} as AuditService,
);

const WELCOME = 'customer.welcome';

async function refusal(
  body: string,
  subject: string | null = 'Welcome',
  key = WELCOME,
) {
  try {
    await service.updateTemplate(key, 'EMAIL', {
      subject,
      body,
      isActive: true,
      baseVersion: 0,
    });
  } catch (error) {
    return error as {
      code: string;
      status: number;
      details: { issue: string }[];
    };
  }
  throw new Error('expected a refusal');
}

describe('updateTemplate validation', () => {
  it('refuses a body that drops a required placeholder', async () => {
    const error = await refusal('Hello there.');
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.details[0].issue).toContain('{{firstName}}');
  });

  it('refuses a placeholder the template does not supply', async () => {
    const error = await refusal('Hello {{firstName}} {{surname}}');
    expect(error.details[0].issue).toContain('{{surname}}');
  });

  it('requires a subject where the built-in wording has one', async () => {
    const error = await refusal('Hello {{firstName}}', null);
    expect(error.details[0]).toMatchObject({ issue: 'A subject is required.' });
  });

  it('answers 404 for a template that does not exist', async () => {
    const error = await refusal('x', null, 'no.such_key');
    expect(error.code).toBe('NOT_FOUND');
  });
});

describe('updateTemplate version check', () => {
  function withStored(version: number | null) {
    const tx = {
      $executeRaw: vi.fn(),
      notificationTemplate: {
        findUnique: vi
          .fn()
          .mockResolvedValue(
            version === null
              ? null
              : { subject: 'Welcome', body: 'x', isActive: true, version },
          ),
        upsert: vi.fn(),
      },
    };
    const prisma = {
      $transaction: (run: (t: typeof tx) => unknown) => run(tx),
    } as unknown as PrismaService;
    return { tx, service: new AdminContentService(prisma, {} as AuditService) };
  }

  const change = (baseVersion: number) => ({
    subject: 'Welcome',
    body: 'Hello {{firstName}}',
    isActive: true,
    baseVersion,
  });

  it.each([
    [3, 2],
    [null, 1],
    [1, 0],
  ])(
    'stored version %s, change made on %s: 409 CONTENT_VERSION_CONFLICT, nothing written',
    async (stored, base) => {
      const { tx, service } = withStored(stored);
      await expect(
        service.updateTemplate(WELCOME, 'EMAIL', change(base)),
      ).rejects.toMatchObject({
        code: 'CONTENT_VERSION_CONFLICT',
        status: 409,
      });
      expect(tx.notificationTemplate.upsert).not.toHaveBeenCalled();
    },
  );
});

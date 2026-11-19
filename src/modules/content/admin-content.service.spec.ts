import { describe, expect, it } from 'vitest';
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

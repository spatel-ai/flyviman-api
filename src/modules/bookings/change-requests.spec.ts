import { ConfigService } from '@nestjs/config';
import { FieldCipher, isEncrypted } from '../../common/crypto/field-cipher.js';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  changeRequestView,
  decisionNotes,
  decisionPayload,
} from './change-requests.js';

const cipher = new FieldCipher({
  getOrThrow: () => Buffer.alloc(32, 9).toString('base64'),
} as unknown as ConfigService);

function row(details: string): Prisma.ChangeRequestGetPayload<object> {
  return {
    id: 'cr-1',
    bookingId: 'b-1',
    kind: 'CHANGE',
    details,
    chargeMinor: null,
    refundMinor: null,
    currency: 'INR',
    status: 'REQUESTED',
    decidedById: null,
    decidedAt: null,
    createdAt: new Date('2026-11-20T10:00:00.000Z'),
    updatedAt: new Date('2026-11-20T10:00:00.000Z'),
  };
}

function eventsDb(payloads: unknown[]) {
  return {
    bookingEvent: {
      findMany: vi
        .fn()
        .mockResolvedValue(payloads.map((payload) => ({ payload }))),
    },
  } as unknown as Pick<Prisma.TransactionClient, 'bookingEvent'>;
}

describe('change request free text', () => {
  it('stores the decision note encrypted and reads it back', async () => {
    const payload = decisionPayload(
      cipher,
      'cr-1',
      'REJECTED',
      'No seats left',
    );
    expect(isEncrypted(payload.note as string)).toBe(true);
    expect(JSON.stringify(payload)).not.toContain('No seats left');
    expect(payload).toMatchObject({
      changeRequestId: 'cr-1',
      decision: 'REJECTED',
    });

    const notes = await decisionNotes(eventsDb([payload]), cipher, 'b-1');
    expect(notes.get('cr-1')).toBe('No seats left');
  });

  it('reads a note written in plain text before encryption as it is', async () => {
    const notes = await decisionNotes(
      eventsDb([
        { changeRequestId: 'cr-1', decision: 'APPROVED', note: 'Done.' },
        // An operator's own note is not a decision.
        { visibility: 'OPERATOR', body: 'x' },
      ]),
      cipher,
      'b-1',
    );
    expect([...notes]).toEqual([['cr-1', 'Done.']]);
  });

  it('shows encrypted details decrypted and legacy plain details unchanged', () => {
    const encrypted = cipher.encrypt('Move to the 14th');
    expect(
      changeRequestView(row(encrypted), 'FLY-1', new Map(), cipher).details,
    ).toBe('Move to the 14th');
    expect(
      changeRequestView(row('Old plain text'), 'FLY-1', new Map(), cipher)
        .details,
    ).toBe('Old plain text');
  });
});

import {
  type FieldCipher,
  isEncrypted,
} from '../../common/crypto/field-cipher.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { BookingEventType } from '../../generated/prisma/enums.js';
import type { ChangeRequestResponseDto } from './dto/booking.dto.js';

/**
 * Change requests have no column for the decision's note, so the note is
 * kept on the booking's timeline: a `NOTE` event whose payload names the
 * request (`decisionPayload`). These read it back. The note and the
 * request's `details` are free text, encrypted at rest (`FieldCipher`).
 * Rows written before that are plain and read as they are: events are
 * append-only, so old notes stay plain (`details` is backfilled,
 * `free-text-backfill.ts`).
 */

type ChangeRequestRow = Prisma.ChangeRequestGetPayload<object>;

export function decisionPayload(
  cipher: FieldCipher,
  changeRequestId: string,
  decision: string,
  note: string,
): Prisma.InputJsonObject {
  return { changeRequestId, decision, note: cipher.encrypt(note) };
}

/** Decrypts a value, or returns one stored in plain text before encryption. */
export function revealLegacy(cipher: FieldCipher, stored: string): string {
  return isEncrypted(stored) ? cipher.decrypt(stored) : stored;
}

/** The decision notes of a booking's requests, by request id. */
export async function decisionNotes(
  db: Pick<Prisma.TransactionClient, 'bookingEvent'>,
  cipher: FieldCipher,
  bookingId: string,
): Promise<Map<string, string>> {
  const events = await db.bookingEvent.findMany({
    where: { bookingId, type: BookingEventType.NOTE },
    select: { payload: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const notes = new Map<string, string>();
  for (const { payload } of events) {
    if (typeof payload !== 'object' || payload === null) continue;
    const { changeRequestId, note } = payload as Record<string, unknown>;
    if (typeof changeRequestId === 'string' && typeof note === 'string') {
      notes.set(changeRequestId, revealLegacy(cipher, note));
    }
  }
  return notes;
}

export function changeRequestView(
  row: ChangeRequestRow,
  bookingReference: string,
  notes: Map<string, string>,
  cipher: FieldCipher,
): ChangeRequestResponseDto {
  return {
    id: row.id,
    bookingReference,
    kind: row.kind,
    status: row.status,
    details: revealLegacy(cipher, row.details),
    decisionNote: notes.get(row.id) ?? null,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

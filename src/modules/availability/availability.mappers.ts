import type {
  AvailabilityBlock,
  AvailabilitySlot,
} from '../../generated/prisma/client.js';
import {
  BlockResponseDto,
  SlotResponseDto,
  SoftHoldConflictDto,
} from './dto/availability.dto.js';

export function toSlot(row: AvailabilitySlot): SlotResponseDto {
  return {
    id: row.id,
    aircraftId: row.aircraftId,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    kind: row.kind,
    originId: row.originId,
  };
}

export function toBlock(row: AvailabilityBlock): BlockResponseDto {
  return {
    id: row.id,
    aircraftId: row.aircraftId,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    reason: row.reason,
    bookingId: row.bookingId,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    note: row.note,
  };
}

export function toConflict(pair: {
  hold: AvailabilityBlock;
  overlaps: AvailabilityBlock;
}): SoftHoldConflictDto {
  return {
    aircraftId: pair.hold.aircraftId,
    hold: toBlock(pair.hold),
    overlaps: toBlock(pair.overlaps),
  };
}

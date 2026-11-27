import { Prisma } from '../../generated/prisma/client.js';
import type { ListSort } from '../../common/dto/list-sort.js';
import type { PrismaService } from '../../prisma/prisma.service.js';

/** The default order of every booking list. */
export const CREATED_DESC: Prisma.BookingOrderByWithRelationInput[] = [
  { createdAt: 'desc' },
  { id: 'desc' },
];

/**
 * One page of the bookings matching `where`, ordered by their first
 * departure (`itinerary.legs[0].departureAt`, stored as an ISO string, so
 * text order is time order; rows without one come last).
 *
 * Text order equals time order only because `instant()` in booking-json.ts
 * accepts UTC instants ending in `Z` alone and every writer stores
 * `Date.toISOString()` (fixed width). Loosening either breaks this sort.
 *
 * The caller's scope stays in `where`: Prisma picks the ids, and the raw
 * statement only orders and slices those ids. The two statements below are
 * fixed text; `sort` chooses between them and no input is spliced in.
 */
export async function bookingIdsByDeparture(
  prisma: PrismaService,
  where: Prisma.BookingWhereInput,
  sort: Exclude<ListSort, 'created_desc'>,
  page: number,
  pageSize: number,
): Promise<{ ids: string[]; total: number }> {
  const scoped = await prisma.booking.findMany({ where, select: { id: true } });
  const all = scoped.map((row) => row.id);
  if (all.length === 0) return { ids: [], total: 0 };
  const offset = (page - 1) * pageSize;
  const rows =
    sort === 'departure_asc'
      ? await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
          SELECT id FROM "Booking"
          WHERE id = ANY(${all}::uuid[])
          ORDER BY (itinerary #>> '{legs,0,departureAt}') COLLATE "C" ASC NULLS LAST, id ASC
          LIMIT ${pageSize} OFFSET ${offset}`)
      : await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
          SELECT id FROM "Booking"
          WHERE id = ANY(${all}::uuid[])
          ORDER BY (itinerary #>> '{legs,0,departureAt}') COLLATE "C" DESC NULLS LAST, id DESC
          LIMIT ${pageSize} OFFSET ${offset}`);
  return { ids: rows.map((row) => row.id), total: all.length };
}

/** Rows in the order of `ids`. */
export function inIdOrder<T extends { id: string }>(
  rows: T[],
  ids: string[],
): T[] {
  const position = new Map(ids.map((id, index) => [id, index]));
  return [...rows].sort((a, b) => position.get(a.id)! - position.get(b.id)!);
}

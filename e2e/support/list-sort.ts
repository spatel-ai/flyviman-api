import { expect } from '@playwright/test';
import { bookingReference } from '../../src/common/reference.js';
import type { Prisma } from '../../src/generated/prisma/client.js';
import { withPrisma } from './db.js';

/**
 * A copy of the booking `reference` (same customer, operator, aircraft and
 * status) whose first leg departs at `departureAt`. Used to get several
 * bookings with known departures into one scope. Created later, so it is
 * newer than the source and than earlier copies.
 */
export async function cloneBooking(
  reference: string,
  departureAt: string,
): Promise<string> {
  return withPrisma(async (prisma) => {
    const source = await prisma.booking.findUniqueOrThrow({
      where: { reference },
    });
    const itinerary = structuredClone(source.itinerary) as {
      legs: { departureAt: string }[];
    };
    itinerary.legs[0].departureAt = departureAt;
    const {
      id: _id,
      reference: _reference,
      createdAt: _created,
      updatedAt: _updated,
      acceptedQuoteId: _quote,
      ...rest
    } = source;
    const copy = bookingReference();
    await prisma.booking.create({
      data: {
        ...rest,
        reference: copy,
        itinerary: itinerary as unknown as Prisma.InputJsonValue,
        cancellationTerms: source.cancellationTerms as Prisma.InputJsonValue,
      },
    });
    return copy;
  });
}

/**
 * The booking's own departure and two copies, an earlier one made first and
 * a later one made last, so the newest-first order (later, earlier, own)
 * differs from the departure order (earlier, own, later).
 */
export async function threeDepartures(reference: string, own: string) {
  const day = 86_400_000;
  const earlier = await cloneBooking(
    reference,
    new Date(Date.parse(own) - day).toISOString(),
  );
  const later = await cloneBooking(
    reference,
    new Date(Date.parse(own) + 2 * day).toISOString(),
  );
  return { earlier, later };
}

export function references(body: { data: { reference: string }[] }) {
  return body.data.map((row) => row.reference);
}

/** Pages of one row each for `path`, concatenated. */
export async function pagedReferences(
  get: (url: string) => Promise<{ json(): Promise<unknown>; status(): number }>,
  path: string,
  pages: number,
): Promise<string[]> {
  const found: string[] = [];
  for (let page = 1; page <= pages; page += 1) {
    const response = await get(
      `${path}${path.includes('?') ? '&' : '?'}page=${page}&pageSize=1`,
    );
    expect(response.status()).toBe(200);
    found.push(...references((await response.json()) as never));
  }
  return found;
}

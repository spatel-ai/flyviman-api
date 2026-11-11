import { HttpStatus, Injectable } from '@nestjs/common';
import { Paginated } from '../../common/dto/paginated.js';
import { AppException } from '../../common/errors/app.exception.js';
import { Prisma } from '../../generated/prisma/client.js';
import type { LocationType } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  escapeLike,
  looksLikeCode,
  normaliseSearchTerm,
} from './location-search.js';

/** `Location.capabilities`; shape in docs/architecture/database-design.md. */
export interface LocationCapabilities {
  /** Null for heliports and where the runway length is unknown. */
  runwayLengthM: number | null;
  /** Null where it is unknown. */
  nightOperations: boolean | null;
  helicopterApproved: boolean;
}

/** The fields anyone may see. Charges and bookkeeping columns are left out. */
export interface PublicLocation {
  id: string;
  type: LocationType;
  name: string;
  iata: string | null;
  icao: string | null;
  city: string | null;
  state: string | null;
  country: string;
  latitude: number;
  longitude: number;
  timeZone: string;
  capabilities: LocationCapabilities;
}

const PUBLIC_SELECT = {
  id: true,
  type: true,
  name: true,
  iata: true,
  icao: true,
  city: true,
  state: true,
  country: true,
  latitude: true,
  longitude: true,
  timeZone: true,
  capabilities: true,
} as const satisfies Prisma.LocationSelect;

const PUBLIC_COLUMNS = Prisma.raw(
  Object.keys(PUBLIC_SELECT)
    .map((column) => `"${column}"`)
    .join(', '),
);

type PublicRow = Omit<PublicLocation, 'capabilities'> & {
  capabilities: Prisma.JsonValue;
};

function toPublic(row: PublicRow): PublicLocation {
  return {
    ...row,
    capabilities: row.capabilities as unknown as LocationCapabilities,
  };
}

function notFound(): AppException {
  return new AppException(
    'NOT_FOUND',
    'Location not found.',
    HttpStatus.NOT_FOUND,
  );
}

/** Owns the Location table. Other modules read locations through it. */
@Injectable()
export class LocationsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Active locations matching a name, city or code. An exact IATA or ICAO
   * code ranks first, then names and cities that start with the term, then
   * any other match; airports before heliports, then by name.
   */
  async search(filter: {
    page: number;
    pageSize: number;
    q?: string;
    type?: LocationType;
  }): Promise<Paginated<PublicLocation>> {
    const term = normaliseSearchTerm(filter.q);
    const conditions: Prisma.Sql[] = [Prisma.sql`"isActive"`];
    if (filter.type) {
      conditions.push(Prisma.sql`"type" = ${filter.type}::"LocationType"`);
    }
    const order: Prisma.Sql[] = [
      Prisma.sql`("type" <> 'AIRPORT')`,
      Prisma.sql`"name"`,
      Prisma.sql`"id"`,
    ];
    if (term) {
      const code = term.toUpperCase();
      const prefix = `${escapeLike(term)}%`;
      const contains = `%${escapeLike(term)}%`;
      const matches = [
        Prisma.sql`"iata" = ${code}`,
        Prisma.sql`"name" ILIKE ${contains}`,
        Prisma.sql`"city" ILIKE ${contains}`,
      ];
      if (looksLikeCode(term)) {
        matches.push(Prisma.sql`"icao" LIKE ${`${code}%`}`);
      }
      conditions.push(Prisma.sql`(${Prisma.join(matches, ' OR ')})`);
      order.unshift(Prisma.sql`CASE
        WHEN "iata" = ${code} OR "icao" = ${code} THEN 0
        WHEN "name" ILIKE ${prefix} THEN 1
        WHEN "city" ILIKE ${prefix} THEN 2
        ELSE 3 END`);
    }
    const where = Prisma.join(conditions, ' AND ');

    const [rows, [{ total }]] = await Promise.all([
      this.prisma.$queryRaw<PublicRow[]>`
        SELECT ${PUBLIC_COLUMNS} FROM "Location" WHERE ${where}
        ORDER BY ${Prisma.join(order)}
        LIMIT ${filter.pageSize} OFFSET ${(filter.page - 1) * filter.pageSize}`,
      this.prisma.$queryRaw<[{ total: number }]>`
        SELECT COUNT(*)::int AS total FROM "Location" WHERE ${where}`,
    ]);
    return new Paginated(
      rows.map(toPublic),
      filter.page,
      filter.pageSize,
      total,
    );
  }

  /** An active location, for public use. */
  async getActive(id: string): Promise<PublicLocation> {
    const row = await this.prisma.location.findFirst({
      where: { id, isActive: true },
      select: PUBLIC_SELECT,
    });
    if (!row) throw notFound();
    return toPublic(row);
  }
}
